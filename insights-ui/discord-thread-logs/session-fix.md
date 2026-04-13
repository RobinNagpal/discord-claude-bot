# Thread: session-fix

Worktree: /home/ubuntu/discord-claude-bot/insights-ui/worktrees/session-fix

---

## Claude — ClaudeCode — 2026-04-12T16:57:53.616Z

[thread created]

**Task:** I want you to start a new task for session-fix
**Worktree:** `/home/ubuntu/discord-claude-bot/insights-ui/worktrees/session-fix`
**Branch:** `session-fix`

Starting work — follow up in this thread to continue the conversation.

---

## User — robinnagpal — 2026-04-12T16:57:53.616Z

I want you to start a new task for session-fix

---

## Claude — ClaudeCode — 2026-04-12T16:58:46.901Z

What specific issue or change should the session-fix branch address? Please describe the bug, feature, or improvement you'd like implemented.

---

## User — robinnagpal — 2026-04-12T16:59:34.919Z

I see this issue

Request Info
SpaceId
----
Blockchain
----
Message
invalid signature. Error occurred while processing the request host: koalagains.com, origin: https://koalagains.com/, url: https://koalagains.com/api/koala_gains/users/portfolio-manager-profiles/by-user/cmfkkag6k0000l804cvyjbxpz, searchParams:


Error
Name
JsonWebTokenError
Message
invalid signature
Stack
JsonWebTokenError: invalid signature
at /var/task/insights-ui/.next/server/chunks/1666.js:3:157423
at u (/var/task/insights-ui/.next/server/chunks/1666.js:3:156241)
at a.exports [as verify] (/var/task/insights-ui/.next/server/chunks/1666.js:3:156259)
at i (/var/task/insights-ui/.next/server/app/api/[spaceId]/etfs-v1/etf-admin-reports/route.js:1:8264)
at /var/task/insights-ui/.next/server/app/api/[spaceId]/etfs-v1/etf-admin-reports/route.js:1:9995
at process.processTicksAndRejections (node:internal/process/task_queues:103:5)
at async rN.do (/var/task/nodemodules/.pnpm/next@15.5.7@babel+core@7.29.0_react-dom@18.3.1_react@18.3.1__react@18.3.1_sass@1.97.3/node_modules/next/dist/compiled/next-server/app-route.runtime.prod.js:5:21042)

When this erros comes, I wan to logout the user and want to show them a notification and ask them to login again

---

## Claude — ClaudeCode — 2026-04-12T17:12:35.929Z

API now returns 401 for JWT errors (invalid signature, expired token) and frontend fetch hooks auto-logout the user with a "session expired" notification and redirect to login.
Files: shared/web-core/src/api/helpers/middlewares/withErrorHandling.ts, shared/web-core/src/ui/hooks/fetch/useFetchData.ts, shared/web-core/src/ui/hooks/fetch/useUpdateData.ts
PR: https://github.com/RobinNagpal/dodao-ui/pull/1288
Build fails due to pre-existing missing AWS env vars (KOALA_AWS_ACCESS_KEY_ID), not related to these changes — TypeScript compilation and lint pass clean.

---

## User — robinnagpal — 2026-04-12T17:13:22.202Z

this is a very critical functionality. Are you sure it will not cause any issues at all?

---

## Claude — ClaudeCode — 2026-04-12T17:18:39.166Z

Audited the 401 auto-logout for edge cases and fixed a critical issue: pages with multiple fetch hooks (up to 8+) would fire duplicate signOut() calls and notifications simultaneously. Added a module-level guard (handleUnauthorized.ts) so only the first 401 triggers logout.
Files: shared/web-core/src/ui/hooks/fetch/handleUnauthorized.ts, shared/web-core/src/ui/hooks/fetch/useFetchData.ts, shared/web-core/src/ui/hooks/fetch/useUpdateData.ts
PR: https://github.com/RobinNagpal/dodao-ui/pull/1288
