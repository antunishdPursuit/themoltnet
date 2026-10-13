package main

import (
	"context"
	"fmt"

	moltnetapi "github.com/getlarge/themoltnet/libs/moltnet-api-client"
	"github.com/google/uuid"
)

func parseGroupUUID(label, value string) (uuid.UUID, error) {
	id, err := uuid.Parse(value)
	if err != nil {
		return uuid.Nil, fmt.Errorf("invalid %s %q: %w", label, value, err)
	}
	return id, nil
}

func runGroupsCreateCmd(apiURL, credPath, teamID, name string) error {
	id, err := parseGroupUUID("team ID", teamID)
	if err != nil {
		return err
	}
	client, err := newAuthenticatedClient(apiURL, credPath, teamID)
	if err != nil {
		return err
	}
	res, err := client.CreateGroup(context.Background(), &moltnetapi.CreateGroupReq{Name: name}, moltnetapi.CreateGroupParams{ID: id})
	if err != nil {
		return fmt.Errorf("teams groups create: %w", formatTransportError(err))
	}
	created, ok := res.(*moltnetapi.CreateGroupCreated)
	if !ok {
		return formatAPIError(res)
	}
	return printJSON(created)
}

func runGroupsListCmd(apiURL, credPath, teamID string) error {
	id, err := parseGroupUUID("team ID", teamID)
	if err != nil {
		return err
	}
	client, err := newAuthenticatedClient(apiURL, credPath, teamID)
	if err != nil {
		return err
	}
	res, err := client.ListGroups(context.Background(), moltnetapi.ListGroupsParams{ID: id})
	if err != nil {
		return fmt.Errorf("teams groups list: %w", formatTransportError(err))
	}
	listed, ok := res.(*moltnetapi.ListGroupsOK)
	if !ok {
		return formatAPIError(res)
	}
	return printJSON(listed)
}

func runGroupsGetCmd(apiURL, credPath, groupID string) error {
	id, err := parseGroupUUID("group ID", groupID)
	if err != nil {
		return err
	}
	client, err := newAuthenticatedClient(apiURL, credPath)
	if err != nil {
		return err
	}
	res, err := client.GetGroup(context.Background(), moltnetapi.GetGroupParams{GroupId: id})
	if err != nil {
		return fmt.Errorf("teams groups get: %w", formatTransportError(err))
	}
	group, ok := res.(*moltnetapi.GetGroupOK)
	if !ok {
		return formatAPIError(res)
	}
	return printJSON(group)
}

func runGroupsDeleteCmd(apiURL, credPath, groupID string) error {
	id, err := parseGroupUUID("group ID", groupID)
	if err != nil {
		return err
	}
	client, err := newAuthenticatedClient(apiURL, credPath)
	if err != nil {
		return err
	}
	res, err := client.DeleteGroup(context.Background(), moltnetapi.DeleteGroupParams{GroupId: id})
	if err != nil {
		return fmt.Errorf("teams groups delete: %w", formatTransportError(err))
	}
	deleted, ok := res.(*moltnetapi.DeleteGroupOK)
	if !ok {
		return formatAPIError(res)
	}
	return printJSON(deleted)
}

func runGroupsMembersListCmd(apiURL, credPath, groupID string) error {
	id, err := parseGroupUUID("group ID", groupID)
	if err != nil {
		return err
	}
	client, err := newAuthenticatedClient(apiURL, credPath)
	if err != nil {
		return err
	}
	res, err := client.ListGroupMembers(context.Background(), moltnetapi.ListGroupMembersParams{GroupId: id})
	if err != nil {
		return fmt.Errorf("teams groups members list: %w", formatTransportError(err))
	}
	listed, ok := res.(*moltnetapi.ListGroupMembersOK)
	if !ok {
		return formatAPIError(res)
	}
	return printJSON(listed)
}

func runGroupsMembersAddCmd(apiURL, credPath, groupID, subjectID, subjectNS string) error {
	id, err := parseGroupUUID("group ID", groupID)
	if err != nil {
		return err
	}
	subject, err := parseGroupUUID("subject ID", subjectID)
	if err != nil {
		return err
	}
	if subjectNS != "Agent" && subjectNS != "Human" {
		return fmt.Errorf("invalid subject namespace %q: expected Agent or Human", subjectNS)
	}
	client, err := newAuthenticatedClient(apiURL, credPath)
	if err != nil {
		return err
	}
	request := &moltnetapi.AddGroupMemberReq{
		SubjectId: subject,
		SubjectNs: moltnetapi.OptAddGroupMemberReqSubjectNs{Value: moltnetapi.AddGroupMemberReqSubjectNs(subjectNS), Set: true},
	}
	res, err := client.AddGroupMember(context.Background(), request, moltnetapi.AddGroupMemberParams{GroupId: id})
	if err != nil {
		return fmt.Errorf("teams groups members add: %w", formatTransportError(err))
	}
	added, ok := res.(*moltnetapi.AddGroupMemberCreated)
	if !ok {
		return formatAPIError(res)
	}
	return printJSON(added)
}

func runGroupsMembersRemoveCmd(apiURL, credPath, groupID, subjectID string) error {
	id, err := parseGroupUUID("group ID", groupID)
	if err != nil {
		return err
	}
	subject, err := parseGroupUUID("subject ID", subjectID)
	if err != nil {
		return err
	}
	client, err := newAuthenticatedClient(apiURL, credPath)
	if err != nil {
		return err
	}
	res, err := client.RemoveGroupMember(context.Background(), moltnetapi.RemoveGroupMemberParams{GroupId: id, SubjectId: subject})
	if err != nil {
		return fmt.Errorf("teams groups members remove: %w", formatTransportError(err))
	}
	removed, ok := res.(*moltnetapi.RemoveGroupMemberOK)
	if !ok {
		return formatAPIError(res)
	}
	return printJSON(removed)
}
