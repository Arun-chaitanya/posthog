import * as Sentry from '@sentry/node'
import { captureException } from '@sentry/node'
import { mkdirSync, rmSync } from 'node:fs'
import { CODES, features, librdkafkaVersion, Message, TopicPartition } from 'node-rdkafka-acosom'
import { Counter, Gauge, Histogram } from 'prom-client'

import { sessionRecordingConsumerConfig } from '../../../config/config'
import { KAFKA_SESSION_RECORDING_SNAPSHOT_ITEM_EVENTS } from '../../../config/kafka-topics'
import { BatchConsumer, startBatchConsumer } from '../../../kafka/batch-consumer'
import { createRdConnectionConfigFromEnvVars } from '../../../kafka/config'
import { PipelineEvent, PluginsServerConfig, RawEventMessage, RedisPool, TeamId } from '../../../types'
import { BackgroundRefresher } from '../../../utils/background-refresher'
import { PostgresRouter } from '../../../utils/db/postgres'
import { timeoutGuard } from '../../../utils/db/utils'
import { status } from '../../../utils/status'
import { asyncTimeoutGuard } from '../../../utils/timing'
import { fetchTeamTokensWithRecordings } from '../../../worker/ingestion/team-manager'
import { ObjectStorage } from '../../services/object_storage'
import { addSentryBreadcrumbsEventListeners } from '../kafka-metrics'
import { eventDroppedCounter } from '../metrics'
import { OffsetHighWaterMarker } from './services/offset-high-water-marker'
import { PartitionLocker } from './services/partition-locker'
import { RealtimeManager } from './services/realtime-manager'
import { ReplayEventsIngester } from './services/replay-events-ingester'
import { SessionManager } from './services/session-manager'
import { IncomingRecordingMessage } from './types'
import { bufferFileDir, now } from './utils'

// Must require as `tsc` strips unused `import` statements and just requiring this seems to init some globals
require('@sentry/tracing')

const groupId = 'session-recordings-blob'
const sessionTimeout = 30000
const PARTITION_LOCK_INTERVAL_MS = 10000
const HIGH_WATERMARK_KEY = 'session_replay_blob_ingester'

// const flushIntervalTimeoutMs = 30000

const gaugeSessionsHandled = new Gauge({
    name: 'recording_blob_ingestion_session_manager_count',
    help: 'A gauge of the number of sessions being handled by this blob ingestion consumer',
})

const gaugeSessionsRevoked = new Gauge({
    name: 'recording_blob_ingestion_sessions_revoked',
    help: 'A gauge of the number of sessions being revoked when partitions are revoked when a re-balance occurs',
})

const gaugeRealtimeSessions = new Gauge({
    name: 'recording_realtime_sessions',
    help: 'Number of real time sessions being handled by this blob ingestion consumer',
})

const gaugeLagMilliseconds = new Gauge({
    name: 'recording_blob_ingestion_lag_in_milliseconds',
    help: "A gauge of the lag in milliseconds, more useful than lag in messages since it affects how much work we'll be pushing to redis",
    labelNames: ['partition'],
})

// NOTE: This gauge is important! It is used as our primary metric for scaling up / down
const gaugeLag = new Gauge({
    name: 'recording_blob_ingestion_lag',
    help: 'A gauge of the lag in messages, taking into account in progress messages',
    labelNames: ['partition'],
})

const gaugeOffsetCommitted = new Gauge({
    name: 'offset_manager_offset_committed',
    help: 'When a session manager flushes to S3 it reports which offset on the partition it flushed.',
    labelNames: ['partition'],
})

const gaugeOffsetCommitFailed = new Gauge({
    name: 'offset_manager_offset_commit_failed',
    help: 'An attempt to commit failed, other than accidentally committing just after a rebalance this is not great news.',
    labelNames: ['partition'],
})

const histogramKafkaBatchSize = new Histogram({
    name: 'recording_blob_ingestion_kafka_batch_size',
    help: 'The size of the batches we are receiving from Kafka',
    buckets: [0, 50, 100, 150, 200, 250, 300, 350, 400, 450, 500, 600, Infinity],
})

const counterKafkaMessageReceived = new Counter({
    name: 'recording_blob_ingestion_kafka_message_received',
    help: 'The number of messages we have received from Kafka',
    labelNames: ['partition'],
})

type PartitionMetrics = {
    lastMessageTimestamp?: number
    lastMessageOffset?: number
    lastKnownCommit?: number
}

export class SessionRecordingIngesterV2 {
    sessions: Record<string, SessionManager> = {}
    offsetHighWaterMarker: OffsetHighWaterMarker
    realtimeManager: RealtimeManager
    replayEventsIngester: ReplayEventsIngester
    partitionLocker: PartitionLocker
    batchConsumer?: BatchConsumer
    partitionAssignments: Record<number, PartitionMetrics> = {}
    partitionLockInterval: NodeJS.Timer | null = null
    teamsRefresher: BackgroundRefresher<Record<string, TeamId>>
    offsetsRefresher: BackgroundRefresher<Record<number, number>>
    recordingConsumerConfig: PluginsServerConfig
    topic = KAFKA_SESSION_RECORDING_SNAPSHOT_ITEM_EVENTS

    constructor(
        private serverConfig: PluginsServerConfig,
        private postgres: PostgresRouter,
        private objectStorage: ObjectStorage,
        private redisPool: RedisPool
    ) {
        this.recordingConsumerConfig = sessionRecordingConsumerConfig(this.serverConfig)
        this.realtimeManager = new RealtimeManager(this.redisPool, this.recordingConsumerConfig)
        this.partitionLocker = new PartitionLocker(
            this.redisPool,
            this.recordingConsumerConfig.SESSION_RECORDING_REDIS_PREFIX
        )

        this.offsetHighWaterMarker = new OffsetHighWaterMarker(
            this.redisPool,
            serverConfig.SESSION_RECORDING_REDIS_PREFIX
        )

        this.replayEventsIngester = new ReplayEventsIngester(this.serverConfig, this.offsetHighWaterMarker)

        this.teamsRefresher = new BackgroundRefresher(async () => {
            try {
                status.info('🔁', 'blob_ingester_consumer - refreshing teams in the background')
                return await fetchTeamTokensWithRecordings(this.postgres)
            } catch (e) {
                status.error('🔥', 'blob_ingester_consumer - failed to refresh teams in the background', e)
                captureException(e)
                throw e
            }
        })

        this.offsetsRefresher = new BackgroundRefresher(async () => {
            const results = await Promise.all(
                Object.keys(this.partitionAssignments).map(async (partition) => {
                    return new Promise<[number, number]>((resolve, reject) => {
                        if (!this.batchConsumer) {
                            return reject('Not connected')
                        }
                        this.batchConsumer.consumer.queryWatermarkOffsets(
                            KAFKA_SESSION_RECORDING_SNAPSHOT_ITEM_EVENTS,
                            parseInt(partition),
                            (err, offsets) => {
                                if (err) {
                                    status.error('🔥', 'Failed to query kafka watermark offsets', err)
                                    return reject()
                                }

                                resolve([parseInt(partition), offsets.highOffset])
                            }
                        )
                    })
                })
            )

            return results.reduce((acc, [partition, highOffset]) => {
                acc[partition] = highOffset
                return acc
            }, {} as Record<number, number>)
        }, 5000)
    }

    public async consume(event: IncomingRecordingMessage, sentrySpan?: Sentry.Span): Promise<void> {
        // we have to reset this counter once we're consuming messages since then we know we're not re-balancing
        // otherwise the consumer continues to report however many sessions were revoked at the last re-balance forever
        gaugeSessionsRevoked.reset()

        const { team_id, session_id } = event
        const key = `${team_id}-${session_id}`

        const { offset } = event.metadata

        const highWaterMarkSpan = sentrySpan?.startChild({
            op: 'checkHighWaterMark',
        })

        if (await this.offsetHighWaterMarker.isBelowHighWaterMark(event.metadata, session_id, offset)) {
            eventDroppedCounter
                .labels({
                    event_type: 'session_recordings_blob_ingestion',
                    drop_cause: 'high_water_mark',
                })
                .inc()

            highWaterMarkSpan?.finish()
            return
        }

        // Check that we are not below the high water mark for this partition (another consumer may have flushed further than us when revoking)
        if (await this.offsetHighWaterMarker.isBelowHighWaterMark(event.metadata, HIGH_WATERMARK_KEY, offset)) {
            eventDroppedCounter
                .labels({
                    event_type: 'session_recordings_blob_ingestion',
                    drop_cause: 'high_water_mark_partition',
                })
                .inc()

            highWaterMarkSpan?.finish()
            return
        }

        if (!this.sessions[key]) {
            const { partition, topic } = event.metadata

            const sessionManager = new SessionManager(
                this.serverConfig,
                this.objectStorage.s3,
                this.realtimeManager,
                this.offsetHighWaterMarker,
                team_id,
                session_id,
                partition,
                topic
            )

            this.sessions[key] = sessionManager
        }

        await this.sessions[key]?.add(event)
        // TODO: If we error here, what should we do...?
        // If it is unrecoverable we probably want to remove the offset
        // If it is recoverable, we probably want to retry?
    }

    public async parseKafkaMessage(
        message: Message,
        getTeamFn: (s: string) => Promise<TeamId | null>
    ): Promise<IncomingRecordingMessage | void> {
        const statusWarn = (reason: string, extra?: Record<string, any>) => {
            status.warn('⚠️', 'invalid_message', {
                reason,
                partition: message.partition,
                offset: message.offset,
                ...(extra || {}),
            })
        }

        if (!message.value || !message.timestamp) {
            // Typing says this can happen but in practice it shouldn't
            return statusWarn('message value or timestamp is empty')
        }

        let messagePayload: RawEventMessage
        let event: PipelineEvent

        try {
            messagePayload = JSON.parse(message.value.toString())
            event = JSON.parse(messagePayload.data)
        } catch (error) {
            return statusWarn('invalid_json', { error })
        }

        if (event.event !== '$snapshot_items' || !event.properties?.$snapshot_items?.length) {
            status.warn('🙈', 'Received non-snapshot message, ignoring')
            return
        }

        if (messagePayload.team_id == null && !messagePayload.token) {
            return statusWarn('no_token')
        }

        let teamId: TeamId | null = null
        const token = messagePayload.token

        if (token) {
            teamId = await getTeamFn(token)
        }

        if (teamId == null) {
            eventDroppedCounter
                .labels({
                    event_type: 'session_recordings_blob_ingestion',
                    drop_cause: 'team_missing_or_disabled',
                })
                .inc()

            return statusWarn('team_missing_or_disabled', {
                token: messagePayload.token,
                teamId: messagePayload.team_id,
                payloadTeamSource: messagePayload.team_id ? 'team' : messagePayload.token ? 'token' : 'unknown',
            })
        }

        const recordingMessage: IncomingRecordingMessage = {
            metadata: {
                partition: message.partition,
                topic: message.topic,
                offset: message.offset,
                timestamp: message.timestamp,
            },

            team_id: teamId,
            distinct_id: messagePayload.distinct_id,
            session_id: event.properties?.$session_id,
            window_id: event.properties?.$window_id,
            events: event.properties.$snapshot_items,
        }

        return recordingMessage
    }

    public async handleEachBatch(messages: Message[]): Promise<void> {
        await asyncTimeoutGuard(
            { message: 'Processing batch is taking longer than 60 seconds', timeout: 60 * 1000 },
            async () => {
                const transaction = Sentry.startTransaction({ name: `blobIngestion_handleEachBatch` }, {})
                histogramKafkaBatchSize.observe(messages.length)

                const recordingMessages: IncomingRecordingMessage[] = []

                if (this.serverConfig.SESSION_RECORDING_PARTITION_REVOKE_OPTIMIZATION) {
                    await this.partitionLocker.claim(messages)
                }

                for (const message of messages) {
                    const { partition, offset, timestamp } = message

                    if (timestamp && this.partitionAssignments[partition]) {
                        const metrics = this.partitionAssignments[partition]

                        // For some reason timestamp can be null. If it isn't, update our ingestion metrics
                        metrics.lastMessageTimestamp = timestamp
                        // If we don't have a last known commit then set it to this offset as we can't commit lower than that
                        metrics.lastKnownCommit = metrics.lastKnownCommit ?? offset
                        metrics.lastMessageOffset = offset

                        counterKafkaMessageReceived.inc({ partition })

                        gaugeLagMilliseconds
                            .labels({
                                partition: partition.toString(),
                            })
                            .set(now() - timestamp)

                        const offsetsByPartition = await this.offsetsRefresher.get()
                        const highOffset = offsetsByPartition[partition]

                        if (highOffset) {
                            // NOTE: This is an important metric used by the autoscaler
                            gaugeLag.set({ partition }, Math.max(0, highOffset - metrics.lastMessageOffset))
                        }
                    }

                    const recordingMessage = await this.parseKafkaMessage(message, (token) =>
                        this.teamsRefresher.get().then((teams) => teams[token] || null)
                    )

                    if (recordingMessage) {
                        recordingMessages.push(recordingMessage)
                    }
                }

                for (const message of recordingMessages) {
                    const consumeSpan = transaction?.startChild({
                        op: 'blobConsume',
                    })

                    await this.consume(message, consumeSpan)
                    // TODO: We could do this as batch of offsets for the whole lot...
                    consumeSpan?.finish()
                }

                for (const message of messages) {
                    // Now that we have consumed everything, attempt to commit all messages in this batch
                    const { partition, offset } = message
                    await this.commitOffset(message.topic, partition, offset)
                }

                await this.replayEventsIngester.consumeBatch(recordingMessages)
                const timeout = timeoutGuard(`Flushing sessions timed out`, {}, 120 * 1000)
                await this.flushAllReadySessions()
                clearTimeout(timeout)

                transaction.finish()
            }
        )
    }

    public async start(): Promise<void> {
        status.info('🔁', 'blob_ingester_consumer - starting session recordings blob consumer', {
            librdKafkaVersion: librdkafkaVersion,
            kafkaCapabilities: features,
        })

        // Currently we can't reuse any files stored on disk, so we opt to delete them all
        try {
            rmSync(bufferFileDir(this.serverConfig.SESSION_RECORDING_LOCAL_DIRECTORY), { recursive: true, force: true })
            mkdirSync(bufferFileDir(this.serverConfig.SESSION_RECORDING_LOCAL_DIRECTORY), { recursive: true })
        } catch (e) {
            status.error('🔥', 'Failed to recreate local buffer directory', e)
            captureException(e)
            throw e
        }
        await this.realtimeManager.subscribe()
        // Load teams into memory
        await this.teamsRefresher.refresh()

        await this.replayEventsIngester.start()

        if (this.serverConfig.SESSION_RECORDING_PARTITION_REVOKE_OPTIMIZATION) {
            this.partitionLockInterval = setInterval(async () => {
                await this.partitionLocker.claim(
                    Object.keys(this.partitionAssignments).map((partition) => ({
                        partition: parseInt(partition),
                        topic: this.topic,
                    }))
                )
            }, PARTITION_LOCK_INTERVAL_MS)
        }

        const connectionConfig = createRdConnectionConfigFromEnvVars(this.recordingConsumerConfig)

        // Create a node-rdkafka consumer that fetches batches of messages, runs
        // eachBatchWithContext, then commits offsets for the batch.

        this.batchConsumer = await startBatchConsumer({
            connectionConfig,
            groupId,
            topic: KAFKA_SESSION_RECORDING_SNAPSHOT_ITEM_EVENTS,
            sessionTimeout,
            // the largest size of a message that can be fetched by the consumer.
            // the largest size our MSK cluster allows is 20MB
            // we only use 9 or 10MB but there's no reason to limit this 🤷️
            consumerMaxBytes: this.recordingConsumerConfig.KAFKA_CONSUMPTION_MAX_BYTES,
            consumerMaxBytesPerPartition: this.recordingConsumerConfig.KAFKA_CONSUMPTION_MAX_BYTES_PER_PARTITION,
            // our messages are very big, so we don't want to buffer too many
            queuedMinMessages: this.recordingConsumerConfig.SESSION_RECORDING_KAFKA_QUEUE_SIZE,
            consumerMaxWaitMs: this.recordingConsumerConfig.KAFKA_CONSUMPTION_MAX_WAIT_MS,
            consumerErrorBackoffMs: this.recordingConsumerConfig.KAFKA_CONSUMPTION_ERROR_BACKOFF_MS,
            fetchBatchSize: this.recordingConsumerConfig.SESSION_RECORDING_KAFKA_BATCH_SIZE,
            batchingTimeoutMs: this.recordingConsumerConfig.KAFKA_CONSUMPTION_BATCHING_TIMEOUT_MS,
            topicCreationTimeoutMs: this.recordingConsumerConfig.KAFKA_TOPIC_CREATION_TIMEOUT_MS,
            autoCommit: false,
            eachBatch: async (messages) => {
                return await this.handleEachBatch(messages)
            },
        })
        addSentryBreadcrumbsEventListeners(this.batchConsumer.consumer)

        this.batchConsumer.consumer.on('rebalance', async (err, topicPartitions) => {
            /**
             * see https://github.com/Blizzard/node-rdkafka#rebalancing
             *
             * This event is received when the consumer group starts _or_ finishes rebalancing.
             *
             * NB if the partition assignment strategy changes then this code may need to change too.
             * e.g. round-robin and cooperative strategies will assign partitions differently
             */
            if (err.code === CODES.ERRORS.ERR__ASSIGN_PARTITIONS) {
                return this.onAssignPartitions(topicPartitions)
            }

            if (err.code === CODES.ERRORS.ERR__REVOKE_PARTITIONS) {
                return this.onRevokePartitions(topicPartitions)
            }

            // We had a "real" error
            status.error('🔥', 'blob_ingester_consumer - rebalancing error', { err })
            // TODO: immediately die? or just keep going?
        })

        // Make sure to disconnect the producer after we've finished consuming.
        this.batchConsumer.join().finally(() => {
            status.debug('🔁', 'blob_ingester_consumer - batch consumer has finished')
        })

        this.batchConsumer.consumer.on('disconnected', async (err) => {
            // since we can't be guaranteed that the consumer will be stopped before some other code calls disconnect
            // we need to listen to disconnect and make sure we're stopped
            status.info('🔁', 'blob_ingester_consumer batch consumer disconnected, cleaning up', { err })
            await this.stop()
        })
    }

    public async stop(): Promise<void> {
        status.info('🔁', 'blob_ingester_consumer - stopping')

        if (this.partitionLockInterval) {
            clearInterval(this.partitionLockInterval)
        }

        // Mark as stopping so that we don't actually process any more incoming messages, but still keep the process alive
        await this.batchConsumer?.stop()

        // Simulate a revoke command to try and flush all sessions
        // The rebalance event should have done this but we do it again as an extra precaution and to await the flushes
        await this.onRevokePartitions(
            Object.keys(this.partitionAssignments).map((partition) => ({
                partition: parseInt(partition),
                topic: this.topic,
            })) as TopicPartition[]
        )

        await this.realtimeManager.unsubscribe()
        await this.replayEventsIngester.stop()

        // This is inefficient but currently necessary due to new instances restarting from the committed offset point
        await this.destroySessions(Object.entries(this.sessions))

        this.sessions = {}

        gaugeRealtimeSessions.reset()
    }

    public isHealthy() {
        // TODO: Maybe extend this to check if we are shutting down so we don't get killed early.
        return this.batchConsumer?.isHealthy()
    }

    async onAssignPartitions(topicPartitions: TopicPartition[]): Promise<void> {
        topicPartitions.forEach((topicPartition: TopicPartition) => {
            this.partitionAssignments[topicPartition.partition] = {}
        })

        await this.partitionLocker.claim(topicPartitions)
        await this.offsetsRefresher.refresh()
    }

    async onRevokePartitions(topicPartitions: TopicPartition[]): Promise<void> {
        /**
         * The revoke_partitions indicates that the consumer group has had partitions revoked.
         * As a result, we need to drop all sessions currently managed for the revoked partitions
         */

        const revokedPartitions = topicPartitions.map((x) => x.partition)
        if (!revokedPartitions.length) {
            return
        }

        const sessionsToDrop = Object.entries(this.sessions).filter(([_, sessionManager]) =>
            revokedPartitions.includes(sessionManager.partition)
        )

        gaugeSessionsRevoked.set(sessionsToDrop.length)
        gaugeSessionsHandled.remove()

        // Attempt to flush all sessions
        // TODO: Improve this to
        // - work from oldest to newest
        // - have some sort of timeout so we don't get stuck here forever
        if (this.serverConfig.SESSION_RECORDING_PARTITION_REVOKE_OPTIMIZATION) {
            status.info('🔁', `blob_ingester_consumer - flushing ${sessionsToDrop.length} sessions on revoke...`)
            await Promise.allSettled(
                sessionsToDrop
                    .map(([_, x]) => x)
                    .sort((x) => x.buffer.oldestKafkaTimestamp ?? Infinity)
                    .map((x) => x.flush('partition_shutdown'))
            )
        }

        topicPartitions.forEach((topicPartition: TopicPartition) => {
            const partition = topicPartition.partition

            delete this.partitionAssignments[partition]
            gaugeLag.remove({ partition })
            gaugeLagMilliseconds.remove({ partition })
            gaugeOffsetCommitted.remove({ partition })
            gaugeOffsetCommitFailed.remove({ partition })
            this.offsetHighWaterMarker.revoke(topicPartition)
        })

        if (this.serverConfig.SESSION_RECORDING_PARTITION_REVOKE_OPTIMIZATION) {
            await this.partitionLocker.release(topicPartitions)
        }
        await this.destroySessions(sessionsToDrop)
        await this.offsetsRefresher.refresh()
    }

    async flushAllReadySessions(): Promise<void> {
        const promises: Promise<void>[] = []
        for (const [key, sessionManager] of Object.entries(this.sessions)) {
            // in practice, we will always have a values for latestKafkaMessageTimestamp,
            const referenceTime = this.partitionAssignments[sessionManager.partition]?.lastMessageTimestamp
            if (!referenceTime) {
                status.warn('🤔', 'blob_ingester_consumer - no referenceTime for partition', {
                    partition: sessionManager.partition,
                })
                continue
            }

            const flushPromise = sessionManager
                .flushIfSessionBufferIsOld(referenceTime)
                .catch((err) => {
                    status.error(
                        '🚽',
                        'blob_ingester_consumer - failed trying to flush on idle session: ' + sessionManager.sessionId,
                        {
                            err,
                            session_id: sessionManager.sessionId,
                        }
                    )
                    captureException(err, { tags: { session_id: sessionManager.sessionId } })
                })
                .finally(() => {
                    // If the SessionManager is done (flushed and with no more queued events) then we remove it to free up memory
                    if (sessionManager.isEmpty) {
                        void this.destroySessions([[key, sessionManager]])
                    }
                })

            promises.push(flushPromise)
        }

        await Promise.allSettled(promises)

        gaugeSessionsHandled.set(Object.keys(this.sessions).length)
        gaugeRealtimeSessions.set(
            Object.values(this.sessions).reduce((acc, sessionManager) => acc + (sessionManager.realtimeTail ? 1 : 0), 0)
        )
    }

    // Given a topic and partition and a list of offsets, commit the highest offset
    // that is no longer found across any of the existing sessions.
    // This approach is fault-tolerant in that if anything goes wrong, the next commit on that partition will work
    public async commitOffset(topic: string, partition: number, offset: number): Promise<void> {
        const topicPartition = { topic, partition }
        let potentiallyBlockingSession: SessionManager | undefined

        for (const sessionManager of Object.values(this.sessions)) {
            if (sessionManager.partition === partition && sessionManager.topic === topic) {
                const lowestOffset = sessionManager.getLowestOffset()
                if (
                    lowestOffset !== null &&
                    lowestOffset < (potentiallyBlockingSession?.getLowestOffset() || Infinity)
                ) {
                    potentiallyBlockingSession = sessionManager
                }
            }
        }

        const potentiallyBlockingOffset = potentiallyBlockingSession?.getLowestOffset() ?? null

        // If we have any other session for this topic-partition then we can only commit offsets that are lower than it
        const highestOffsetToCommit =
            potentiallyBlockingOffset !== null && potentiallyBlockingOffset < offset
                ? potentiallyBlockingOffset
                : offset

        const lastKnownCommit = this.partitionAssignments[partition]?.lastKnownCommit || 0
        // TODO: Check how long we have been blocked by any individual session and if it is too long then we should
        // capture an exception to figure out why
        if (lastKnownCommit >= highestOffsetToCommit) {
            // If we have already commited this offset then we don't need to do it again
            return
        }

        if (this.partitionAssignments[partition]) {
            this.partitionAssignments[partition].lastKnownCommit = highestOffsetToCommit
        }

        status.info('💾', `blob_ingester_consumer.commitOffsets - attempting to commit offset`, {
            partition,
            offsetToCommit: highestOffsetToCommit,
        })

        this.batchConsumer?.consumer.commit({
            ...topicPartition,
            // see https://kafka.apache.org/10/javadoc/org/apache/kafka/clients/consumer/KafkaConsumer.html for example
            // for some reason you commit the next offset you expect to read and not the one you actually have
            offset: highestOffsetToCommit + 1,
        })

        await this.offsetHighWaterMarker.add(topicPartition, HIGH_WATERMARK_KEY, highestOffsetToCommit)
        await this.offsetHighWaterMarker.clear({ topic, partition }, highestOffsetToCommit)
        gaugeOffsetCommitted.set({ partition }, highestOffsetToCommit)
    }

    public async destroySessions(sessionsToDestroy: [string, SessionManager][]): Promise<void> {
        const destroyPromises: Promise<void>[] = []

        sessionsToDestroy.forEach(([key, sessionManager]) => {
            delete this.sessions[key]
            destroyPromises.push(sessionManager.destroy())
        })

        await Promise.allSettled(destroyPromises)
    }
}
