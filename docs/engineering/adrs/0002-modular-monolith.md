# ADR-0002: Start as a modular monolith

- Status: Accepted
- Date: 2026-09-06

## Context

AgencyHQ needs strong domain boundaries but has no demonstrated independent
scaling, deployment, or ownership requirement for internal microservices.

## Decision

Build the web control plane and coordinator as a small TypeScript workspace with
separate domain, contracts, database, and verification packages. Deploy the
application in the smallest useful shape and use typed in-process boundaries
except at real external systems.

Do not add Kubernetes, Kafka, Temporal, LangGraph, a graph database, or extra
services without a concrete requirement and a superseding ADR.

## Consequences

Local development, transactions, and refactoring remain simple. Package APIs
still make future extraction possible, but extraction is not predesigned.

