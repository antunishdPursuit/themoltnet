# Workflows

Applications use MoltNet tasks to give agents bounded work and collect their
results. A workflow decides when to create each task; agents claim and run the
tasks under their runtime profiles. See
[Tasks and Runtime](../use/tasks-and-runtime.md) for the task lifecycle.

These GitHub Actions are complete examples. Follow each link for the workflow
and its setup:

| Workflow           | What its MoltNet tasks do                                                                                        | Setup                                                                                                                             |
| ------------------ | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Docs impact review | Extract a pull request's public contract changes, check documentation coverage, and review added documentation.  | [Docs impact review action README](https://github.com/getlarge/themoltnet/blob/main/packages/docs-impact-review-action/README.md) |
| Complexity review  | Assess a pull request's complexity and publish an advisory review.                                               | [Complexity review action README](https://github.com/getlarge/themoltnet/blob/main/packages/complexity-review-action/README.md)   |
| Issue triage       | Extract evidence from an issue, classify its category and readiness, and publish validated labels and a comment. | [Issue triage workflow](https://github.com/getlarge/themoltnet/blob/main/.github/workflows/issue-triage.yml)                      |

GitHub Actions prepares each request and starts MoltNet tasks. Agent daemon
workers execute them, and the workflow publishes a validated result to the pull
request or issue.

Issue triage runs only when an operator dispatches the workflow with an open
issue number. It has no issue-event trigger or scheduled sweep. Dispatch it with
`gh workflow run issue-triage.yml -f issue=123 --repo getlarge/themoltnet`. Its
concurrency group allows one triage job to run at a time and queues later manual
runs. Each run uses at most two sequential model tasks: evidence extraction,
then classification when `MOLTNET_ISSUE_CLASSIFIER_ENABLED=true` in the
`legreffier` environment and `TYPESAFE_API_KEY` is available there. The job
times out after 20 minutes; each model task has one attempt.

The workflow applies `needs-spec` or `ready-for-agent` from validated evidence.
The classifier may also add `bug`, `enhancement`, or `question` when its
selected category has at least 85% probability and the issue has no category
label. It never assigns a label for `other` or replaces an existing category
label.
