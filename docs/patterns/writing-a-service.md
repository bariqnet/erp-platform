# Pattern — Writing a Service

> **Status:** Stub. Populated as services accumulate, starting in **TASK-10**.

## Problem

CLAUDE.md §5: services own business logic. Routes are thin; databases
are dumb. Services compose repositories, the EventBus port, and
domain primitives. Expected failures return `Result<T, E>`; truly
exceptional cases throw.

## When to use

- You are about to add business logic to a route handler — stop and
  put it in a service instead.
- You are coordinating two or more repositories.
- You are emitting domain events.

## Skeleton

Service skeleton — class with constructor injection of repositories
and the EventBus port, methods returning `Result<T, E>` for expected
failures, full path coverage by unit tests — is documented when the
first real service ships in TASK-10.

## Verified by

- Code review against the unit-test coverage targets in CLAUDE.md §8
  (90%+ for `core` and `metadata`, 85%+ for `change-set`).
