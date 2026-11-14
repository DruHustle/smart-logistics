# Smart Logistics engineering

`DruHustle/smart-logistics` is the consolidated canonical repository. Preserve
the independently deployed frontend, Node API and .NET services, their existing
identifiers and data. Read `README.md`, `docs/CONSOLIDATED_RELEASE.md` and the
affected component docs. Follow the additional backend image-retention policy.

Keep extra worktrees in `local-tools/worktrees`, deployment evidence in
`local-tools/deployment-evidence`, verification evidence in
`local-tools/release-verification`, and migration records in
`local-tools/migrations`. Do not create workspace-root release folders. Keep
secrets, customer records, raw private provider configuration and signing keys
out of Git, reports and CI artifacts. Preserve concurrent changes and history.

Use Node 22.12+ within 22.x, the committed pnpm 10.34.5 pin through Corepack,
Python 3.10+, .NET SDK 8 and Docker Compose. Run the relevant
`node local-tools/ci/local-checks.mjs` suites. The .NET 10 SDK does not replace
the pinned .NET 8 toolchain. Browser, PostgreSQL/gateway and isolated restoration
qualification remain separate from source tests and public website checks.
Use only explicit disposable loopback `_test` databases for new identity checks;
`npm run test:onesa` in the Node API verifies the callback/database boundary.

Onesa Identity at `auth.onesa.eu` owns human sign-in and product grants for the
managed pilot. Portal is the legacy issuer during migration. Validate the
Logistics API audience and signed stable Onesa ID. An approved ordinary account
must not acquire an admin role or workspace membership from sign-in. Preserve
issuer/subject binding, explicit local-account linking proof, PKCE/state replay
guards and live grant checks. Central administration requires current MFA;
revocation and downgrade must not leave an elevated local session usable.
Keep shipment/object access scoped to an assigned workspace and preserve
idempotent telemetry and operational events.

Use existing root PR/release workflows; prior source success is not proof of
Oracle migration, deployed revision, protected production acceptance or rollback.
The current workflows use hosted runners; inspect actual runner registrations
before claiming local execution. Free resources only without a budget approval.
