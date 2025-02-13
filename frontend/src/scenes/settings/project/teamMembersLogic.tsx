import { kea, path, actions, selectors, listeners, events } from 'kea'
import { loaders } from 'kea-loaders'
import { forms } from 'kea-forms'
import api from 'lib/api'
import { OrganizationMembershipLevel, TeamMembershipLevel } from 'lib/constants'
import {
    AvailableFeature,
    BaseMemberType,
    ExplicitTeamMemberType,
    FusedTeamMemberType,
    OrganizationMemberType,
    UserBasicType,
    UserType,
} from '~/types'
import type { teamMembersLogicType } from './teamMembersLogicType'
import { membershipLevelToName } from 'lib/utils/permissioning'
import { userLogic } from '../../userLogic'
import { teamLogic } from '../../teamLogic'
import { lemonToast } from 'lib/lemon-ui/lemonToast'
import { membersLogic } from 'scenes/organization/membersLogic'

export const MINIMUM_IMPLICIT_ACCESS_LEVEL = OrganizationMembershipLevel.Admin

export type AddMembersFields = {
    userUuids: string[]
    level: TeamMembershipLevel
}

export const teamMembersLogic = kea<teamMembersLogicType>([
    path(['scenes', 'project', 'Settings', 'teamMembersLogic']),
    actions({
        changeUserAccessLevel: (user: UserBasicType, newLevel: TeamMembershipLevel) => ({
            user,
            newLevel,
        }),
    }),
    loaders(({ values }) => ({
        explicitMembers: {
            __default: [] as ExplicitTeamMemberType[],
            loadMembers: async () => {
                return await api.get(`api/projects/${teamLogic.values.currentTeamId}/explicit_members/`)
            },
            addMembers: async ({ userUuids, level }: AddMembersFields) => {
                const newMembers: ExplicitTeamMemberType[] = await Promise.all(
                    userUuids.map((userUuid) =>
                        api.create(`api/projects/${teamLogic.values.currentTeamId}/explicit_members/`, {
                            user_uuid: userUuid,
                            level,
                        })
                    )
                )
                lemonToast.success(
                    `Added ${newMembers.length} member${newMembers.length !== 1 ? 's' : ''} to the project.`
                )
                return [...values.explicitMembers, ...newMembers]
            },
            removeMember: async ({ member }: { member: BaseMemberType }) => {
                await api.delete(`api/projects/${teamLogic.values.currentTeamId}/explicit_members/${member.user.uuid}/`)
                lemonToast.success(
                    <>
                        {member.user.uuid === userLogic.values.user?.uuid
                            ? 'Left'
                            : `Removed ${member.user.first_name} (${member.user.email}) from`}{' '}
                        the project.
                    </>
                )
                return values.explicitMembers.filter((thisMember) => thisMember.user.uuid !== member.user.uuid)
            },
        },
    })),
    selectors(({ selectors }) => ({
        allMembers: [
            () => [
                teamLogic.selectors.currentTeam,
                userLogic.selectors.hasAvailableFeature,
                selectors.explicitMembers,
                membersLogic.selectors.members,
            ],
            // Explicit project members joined with organization admins and owner (who get project access by default)
            (currentTeam, hasAvailableFeature, explicitMembers, organizationMembers): FusedTeamMemberType[] => {
                if (
                    !currentTeam?.access_control ||
                    !hasAvailableFeature(AvailableFeature.PROJECT_BASED_PERMISSIONING)
                ) {
                    return organizationMembers.map(
                        (member) =>
                            ({
                                ...member,
                                explicit_team_level: null,
                                organization_level: member.level,
                            } as FusedTeamMemberType)
                    )
                }
                return organizationMembers
                    .filter(({ level }) => level >= MINIMUM_IMPLICIT_ACCESS_LEVEL)
                    .map(
                        (member) =>
                            ({
                                ...member,
                                explicit_team_level: null,
                                organization_level: member.level,
                            } as FusedTeamMemberType)
                    )
                    .concat(
                        explicitMembers
                            .filter(({ parent_level }) => parent_level < MINIMUM_IMPLICIT_ACCESS_LEVEL)
                            .map(
                                (member) =>
                                    ({
                                        ...member,
                                        level: member.effective_level,
                                        explicit_team_level: member.level,
                                        organization_level: member.parent_level,
                                    } as FusedTeamMemberType)
                            )
                    )
            },
        ],
        allMembersLoading: [
            () => [selectors.explicitMembersLoading, membersLogic.selectors.membersLoading],
            (explicitMembersLoading, organizationMembersLoading) =>
                explicitMembersLoading || organizationMembersLoading,
        ],
        admins: [
            () => [selectors.allMembers],
            (allMembers: FusedTeamMemberType[]) => allMembers.filter(({ level }) => level >= TeamMembershipLevel.Admin),
        ],
        plainMembers: [
            () => [selectors.allMembers],
            (allMembers: FusedTeamMemberType[]) => allMembers.filter(({ level }) => level < TeamMembershipLevel.Admin),
        ],
        addableMembers: [
            () => [selectors.explicitMembers, membersLogic.selectors.members, userLogic.selectors.user],
            // Organization members processed to indicate if they can be added to the project or not
            (
                explicitMembers: ExplicitTeamMemberType[],
                organizationMembers: OrganizationMemberType[],
                currentUser: UserType
            ): FusedTeamMemberType[] =>
                organizationMembers
                    .filter(({ user }) => user.uuid !== currentUser.uuid)
                    .map((organizationMember) => {
                        const matchedExplicitMember = explicitMembers.find(
                            (explicitMember) => explicitMember.user.uuid === organizationMember.user.uuid
                        )
                        let effectiveLevel: OrganizationMembershipLevel | null
                        if (matchedExplicitMember) {
                            effectiveLevel = Math.max(matchedExplicitMember.effective_level, organizationMember.level)
                        } else {
                            effectiveLevel =
                                organizationMember.level >= MINIMUM_IMPLICIT_ACCESS_LEVEL
                                    ? organizationMember.level
                                    : null
                        }
                        return {
                            ...organizationMember,
                            level: effectiveLevel,
                            explicit_team_level: matchedExplicitMember ? matchedExplicitMember.level : null,
                            organization_level: organizationMember.level,
                        } as FusedTeamMemberType
                    }),
        ],
    })),
    forms(({ actions }) => ({
        addMembers: {
            defaults: { level: TeamMembershipLevel.Member, userUuids: [] } as AddMembersFields,
            errors: ({ userUuids }) => ({
                userUuids: !userUuids || !userUuids.length ? ['Select at least one member to add.'] : undefined,
            }),
            submit: ({ userUuids, level }) => {
                actions.addMembers({ userUuids, level })
            },
        },
    })),
    listeners(({ actions }) => ({
        changeUserAccessLevel: async ({ user, newLevel }) => {
            await api.update(`api/projects/${teamLogic.values.currentTeamId}/explicit_members/${user.uuid}/`, {
                level: newLevel,
            })
            lemonToast.success(
                <>
                    Made <b>{user.first_name}</b> project {membershipLevelToName.get(newLevel)}
                </>
            )
            actions.loadMembers()
        },
    })),
    events(({ actions }) => ({
        afterMount: actions.loadMembers,
    })),
])
