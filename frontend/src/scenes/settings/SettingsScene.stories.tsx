import { Meta } from '@storybook/react'
import { mswDecorator } from '~/mocks/browser'
import preflightJson from '~/mocks/fixtures/_preflight.json'
import { App } from 'scenes/App'
import { useEffect } from 'react'
import { router } from 'kea-router'
import { urls } from 'scenes/urls'

const meta: Meta = {
    title: 'Scenes-Other/Settings',
    parameters: {
        layout: 'fullscreen',
        viewMode: 'story',
        mockDate: '2023-05-25',
    },
    decorators: [
        mswDecorator({
            get: {
                '/_preflight': {
                    ...preflightJson,
                    cloud: true,
                    realm: 'cloud',
                },
            },
        }),
    ],
}
export default meta

export function SettingsProject(): JSX.Element {
    useEffect(() => {
        router.actions.push(urls.settings('project'))
    }, [])
    return <App />
}

export function SettingsUser(): JSX.Element {
    useEffect(() => {
        router.actions.push(urls.settings('user'))
    }, [])
    return <App />
}

export function SettingsOrganization(): JSX.Element {
    useEffect(() => {
        router.actions.push(urls.settings('organization'))
    }, [])
    return <App />
}
