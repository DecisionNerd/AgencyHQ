# Self-hosted Trigger.dev

Compose files and environment notes for the webapp stack (webapp, Postgres,
Redis, Electric, registry, object storage, socket proxy, optional ClickHouse).
On the host profile no worker stack is deployed; `trigger dev` runs on the
OpenCode host and connects to this webapp. AgencyHQ uses its own Postgres and
credentials. Record the pinned `TRIGGER_IMAGE_TAG`, SDK/CLI version, and
OpenCode version here with the execution-trial result that qualified them.
Nothing is provisioned yet.
