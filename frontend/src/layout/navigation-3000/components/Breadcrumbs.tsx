import React, { useEffect, useState } from 'react'
import { useActions, useValues } from 'kea'
import { IconArrowDropDown } from 'lib/lemon-ui/icons'
import { Link } from 'lib/lemon-ui/Link'
import './Breadcrumbs.scss'
import { Breadcrumb as IBreadcrumb } from '~/types'
import clsx from 'clsx'
import { Popover } from 'lib/lemon-ui/Popover/Popover'
import { breadcrumbsLogic } from '~/layout/navigation/Breadcrumbs/breadcrumbsLogic'
import { LemonSkeleton } from '@posthog/lemon-ui'

const COMPACTION_DISTANCE = 44

/**
 * In PostHog 3000 breadcrumbs also serve as the top bar. This is marked by theses two features:
 * - The "More scene actions" button (vertical ellipsis)
 * - The "Quick scene actions" buttons (zero or more buttons on the right)
 */
export function Breadcrumbs(): JSX.Element | null {
    const { breadcrumbs } = useValues(breadcrumbsLogic)
    const { setActionsContainer } = useActions(breadcrumbsLogic)

    const [compactionRate, setCompactionRate] = useState(0)

    useEffect(() => {
        function handleScroll(): void {
            const scrollTop = document.getElementsByTagName('main')[0].scrollTop
            setCompactionRate(Math.min(scrollTop / COMPACTION_DISTANCE, 1))
        }
        const main = document.getElementsByTagName('main')[0]
        main.addEventListener('scroll', handleScroll)
        return () => main.removeEventListener('scroll', handleScroll)
    }, [])

    return breadcrumbs.length ? (
        <div
            className="Breadcrumbs3000"
            style={
                {
                    '--breadcrumbs-compaction-rate': compactionRate,
                } as React.CSSProperties
            }
        >
            <div className="Breadcrumbs3000__content">
                <div className="Breadcrumbs3000__trail">
                    <div className="Breadcrumbs3000__crumbs">
                        {breadcrumbs.slice(0, -1).map((breadcrumb, index) => (
                            <React.Fragment key={breadcrumb.name || '…'}>
                                <Breadcrumb breadcrumb={breadcrumb} index={index} />
                                <div className="Breadcrumbs3000__separator" />
                            </React.Fragment>
                        ))}
                        <Breadcrumb
                            breadcrumb={breadcrumbs[breadcrumbs.length - 1]}
                            index={breadcrumbs.length - 1}
                            here
                        />
                    </div>
                    <Here breadcrumb={breadcrumbs[breadcrumbs.length - 1]} />
                </div>
                <div className="Breadcrumbs3000__actions" ref={setActionsContainer} />
            </div>
        </div>
    ) : null
}

interface BreadcrumbProps {
    breadcrumb: IBreadcrumb
    index: number
    here?: boolean
}

function Breadcrumb({ breadcrumb, index, here }: BreadcrumbProps): JSX.Element {
    const [popoverShown, setPopoverShown] = useState(false)

    const Component = breadcrumb.path ? Link : 'div'
    const breadcrumbContent = (
        <Component
            className={clsx(
                'Breadcrumbs3000__breadcrumb',
                popoverShown && 'Breadcrumbs3000__breadcrumb--open',
                (breadcrumb.path || breadcrumb.popover) && 'Breadcrumbs3000__breadcrumb--actionable',
                here && 'Breadcrumbs3000__breadcrumb--here'
            )}
            onClick={() => {
                breadcrumb.popover && setPopoverShown(!popoverShown)
            }}
            data-attr={`breadcrumb-${index}`}
            to={breadcrumb.path}
        >
            <span>{breadcrumb.name}</span>
            {breadcrumb.popover && <IconArrowDropDown />}
        </Component>
    )

    if (breadcrumb.popover) {
        return (
            <Popover
                {...breadcrumb.popover}
                visible={popoverShown}
                onClickOutside={() => {
                    if (popoverShown) {
                        setPopoverShown(false)
                    }
                }}
                onClickInside={() => {
                    if (popoverShown) {
                        setPopoverShown(false)
                    }
                }}
            >
                {breadcrumbContent}
            </Popover>
        )
    }

    return breadcrumbContent
}

interface HereProps {
    breadcrumb: IBreadcrumb
}

function Here({ breadcrumb }: HereProps): JSX.Element {
    return (
        <h1 className="Breadcrumbs3000__here">
            <span>{breadcrumb.name || <LemonSkeleton className="w-40 h-4" />}</span>
        </h1>
    )
}
