import { LemonBanner, LemonButton, LemonDivider } from '@posthog/lemon-ui'
import { IconChevronRight, IconLink } from 'lib/lemon-ui/icons'
import { SettingsLogicProps, settingsLogic } from './settingsLogic'
import { useActions, useValues } from 'kea'
import { SettingLevelIds } from './types'
import clsx from 'clsx'
import { capitalizeFirstLetter } from 'lib/utils'
import { useResizeBreakpoints } from 'lib/hooks/useResizeObserver'
import { teamLogic } from 'scenes/teamLogic'

import './Settings.scss'
import { NotFound } from 'lib/components/NotFound'

export function Settings({
    hideSections = false,
    ...props
}: SettingsLogicProps & { hideSections?: boolean }): JSX.Element {
    const { selectedSectionId, selectedSection, selectedLevel, sections, isCompactNavigationOpen } = useValues(
        settingsLogic(props)
    )
    const { selectSection, selectLevel, openCompactNavigation } = useActions(settingsLogic(props))
    const { currentTeam } = useValues(teamLogic)

    const { ref, size } = useResizeBreakpoints(
        {
            0: 'small',
            700: 'medium',
        },
        {
            initialSize: 'medium',
        }
    )

    const isCompact = size === 'small'

    const showSections = isCompact ? isCompactNavigationOpen : true

    return (
        <div className={clsx('Settings flex', isCompact && 'Settings--compact')} ref={ref}>
            {hideSections ? null : (
                <>
                    {showSections ? (
                        <div className="Settings__sections">
                            <ul className="space-y-px">
                                {SettingLevelIds.map((level) => (
                                    <li key={level} className="space-y-px">
                                        <LemonButton
                                            onClick={() => selectLevel(level)}
                                            size="small"
                                            fullWidth
                                            active={selectedLevel === level && !selectedSectionId}
                                        >
                                            <span
                                                className={clsx(
                                                    'text-muted-alt',
                                                    level === selectedLevel && 'font-bold'
                                                )}
                                            >
                                                {capitalizeFirstLetter(level)}
                                            </span>
                                        </LemonButton>

                                        <ul className="space-y-px">
                                            {sections
                                                .filter((x) => x.level === level)
                                                .map((section) => (
                                                    <li key={section.id} className="pl-4">
                                                        <LemonButton
                                                            onClick={() => selectSection(section.id)}
                                                            size="small"
                                                            fullWidth
                                                            active={selectedSectionId === section.id}
                                                        >
                                                            {section.title}
                                                        </LemonButton>
                                                    </li>
                                                ))}
                                        </ul>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    ) : (
                        <LemonButton fullWidth sideIcon={<IconChevronRight />} onClick={() => openCompactNavigation()}>
                            {capitalizeFirstLetter(selectedLevel)}
                            {selectedSection ? ` / ${selectedSection.title}` : null}
                        </LemonButton>
                    )}
                    {isCompact ? <LemonDivider /> : null}
                </>
            )}

            <div className="flex-1 w-full space-y-2 overflow-hidden">
                {!hideSections && selectedLevel === 'project' && (
                    <LemonBanner type="info">
                        These settings only apply to the current project{' '}
                        {currentTeam?.name ? (
                            <>
                                (<b>{currentTeam.name}</b>)
                            </>
                        ) : null}
                        .
                    </LemonBanner>
                )}

                <SettingsRenderer {...props} />
            </div>
        </div>
    )
}

function SettingsRenderer(props: SettingsLogicProps): JSX.Element {
    const { settings } = useValues(settingsLogic(props))
    const { selectSetting } = useActions(settingsLogic(props))

    return (
        <div className="space-y-8">
            {settings.length ? (
                settings.map((x) => (
                    <div key={x.id} className="relative">
                        <div
                            id={x.id}
                            className="absolute" // eslint-disable-next-line react/forbid-dom-props
                            style={{
                                marginTop: '-3.5rem', // Account for top bar when scrolling to anchor
                            }}
                        />
                        <h2 className="flex gap-2 items-center">
                            {x.title}{' '}
                            <LemonButton icon={<IconLink />} size="small" onClick={() => selectSetting?.(x.id)} />
                        </h2>
                        {x.description && <p>{x.description}</p>}

                        {x.component}
                    </div>
                ))
            ) : (
                <NotFound object="setting" />
            )}
        </div>
    )
}
