# Global Agent user-capability coverage

Audited against `client/src/App.jsx`, signed-in user pages, mounted `/api` routes,
`agentToolRegistry.js`, and `agentRuntimeComposition.js` on 2026-08-08.

Legend:

- **Direct**: a server Agent handler performs the operation.
- **Browser-mediated**: the server verifies ownership and returns a bounded
  `clientAction`; the signed-in browser performs the local file/download step and
  reports completion to the durable Agent run.
- **Shared tool**: one safe generic tool covers several page-specific actions.

| User surface | User capability / route | Agent tool coverage | Mode |
| --- | --- | --- | --- |
| Home / image generation | templates, models, estimate, generate | `template.search`, `template.use`, `model.list`, `visual-parameter.list`, `media.estimate`, `media.generate.image` | Direct |
| Home / video generation | templates, models, estimate, generate | `template.search`, `template.use`, `model.list`, `visual-parameter.list`, `media.estimate`, `media.generate.video` | Direct |
| Image editing | remove background / object from an owned creation | `media.remove-background`, `media.remove-object` | Direct |
| Community | browse/search/sort, detail, like, favorite, report | `community.list`, `community.get`, `community.like`, `community.favorite`, `community.report` | Direct |
| My community publication | read state, publish, unpublish | `community.publication.get`, `community.publish`, `community.unpublish` | Direct |
| Creation history | paginate/filter/read status | `creation.history`, `creation.get` | Direct; `creation.get` performs owned video reconciliation when required |
| Creation download | one item, batch ZIP, CSV | `creation.download`, `creation.download.batch`, `creation.export.csv` | Browser-mediated |
| Creation deletion | normal deletion and failed creation deletion | `content.delete`, `creation.failed.delete` | Direct; failed deletion releases reserved points and deletes in one idempotent transaction |
| Dashboard / points | balance, membership, ledger | `account.balance`, `account.ledger.list` | Direct |
| Profile | read, display-name update, avatar upload | `profile.read`, `profile.update`, `profile.avatar.upload` | Direct / browser-mediated upload |
| Canvas | list/create/read/replace/patch/delete | `canvas.list`, `canvas.create`, `canvas.read`, `canvas.edit`, `canvas.patch`, `content.delete` | Direct; optimistic concurrency on edits |
| Canvas assets | upload local media, attach an owned creation | `canvas.asset.upload`, `canvas.asset.attach_creation` | Browser-mediated / direct |
| Storyboard / timeline / 3D | edit storyboard, timeline and director state; render/export | `storyboard.edit`, `storyboard.patch`, `timeline.edit`, `timeline.render`, `director3d.edit`, `canvas.export.image` | Direct / browser-mediated local render |
| Workflow | estimate, run, status/events, cancel | `workflow.estimate`, `workflow.run`, `workflow.get`, `workflow.events`, `task.cancel` | Direct |
| Task center | list/get/cancel durable tasks | `task.list`, `task.get`, `task.cancel` | Direct |
| Template marketplace | search/detail/use | `template.search`, `template.use` | Direct |
| Private template studio | create/update/import/export/preview/delete/request public | `template.create`, `template.update`, `template.import`, `template.export`, `template.preview.upload`, `template.delete`, `content.publish` | Direct / browser-mediated preview |
| Digital human | roles, capture links, attach/upload assets, script optimization, generation, deletion | `digital-human.role.*`, `digital-human.script.optimize`, `media.generate.video`, `content.delete` | Direct / browser-mediated upload |
| Recycle bin | list, restore, notifications, mark read | `content.recycle.list`, `content.recycle.restore`, `content.notification.list`, `content.notification.mark-read` | Direct |
| MCP | services, connections, OAuth start/revoke, allowed tools, calls | `mcp.server.list`, `mcp.connection.list`, `mcp.connection.start`, `mcp.connection.revoke`, `mcp.tool.list`, `mcp.call.external` | Direct; OAuth authorization itself remains a human/provider interaction |
| Subscription | plans, overview, order status, cancel renewal | `subscription.plan.list`, `subscription.overview`, `subscription.order.get`, `subscription.renewal.cancel` | Direct |
| Permanent point packages | packages, order status, purchase | `point-package.list`, `point-package.order.get`, `point-package.purchase` | Direct; purchased points never expire and do not change membership |
| Billing purchase / refund | subscription purchase, permanent-point purchase and root refunds | `billing.pay`, `point-package.purchase`, `billing.refund`, `root.point-package.refund` | Direct, but payment/refund always require one-time explicit approval in every Agent mode |

## Enforced invariants

- Handler identity comes only from the authenticated Agent runtime; parameter
  fields cannot replace `userId`, RBAC role, membership tier, or Agent mode.
- Owned resources are selected or mutated with both resource ID and runtime
  user ID. Handler-verified ownership is declared explicitly in
  `AGENT_RUNTIME_TOOLS`.
- Mutations use the existing user-operation idempotency seam where applicable.
- Failed creation deletion releases held points and changes charge state in the
  same transaction before applying the membership recycle-bin policy.
- Payment, permanent-point purchase, and refund operation classes require
  explicit user approval under Full Access. Arbitrary account recharge remains
  unavailable to users and Agents; points are granted only through a verified
  product order or an authorized administrative operation.
- Every registered built-in tool has a concrete handler; registration and
  handler key equality is covered by a composition test.
- Tool execution continues through the execution governor and Agent audit sink.

## Intentional or remaining gaps

1. Alipay periodic-agreement signing is not exposed to Agent while
   `ALIPAY_PERIODIC_ENABLED=false`. It must be added as a payment-class tool with
   crash-safe provider idempotency before that feature flag is enabled.
2. Workflow-node and Agent-step approvals are not Agent tools. Allowing an Agent
   to approve its own guarded action would bypass the three-mode safety model;
   the signed-in user remains the approving actor.
3. Login, registration, logout, email verification, OAuth consent, local camera
   capture, and local file selection require a human browser/device session.
4. Active generation cancellation has no supported user route in the product;
   the Task Center explicitly reports it as unsupported. This is a platform
   capability gap, not an Agent-only gap.
5. Account deletion is disabled by the server. Individual content deletion is
   covered instead.
6. OAuth client secrets, provider API keys and server secrets are intentionally
   not accepted as Agent tool parameters. They remain server-side configuration.

## Administrator and root Agent coverage

Every tool below is filtered from the catalog by the authenticated database
role, checked again by Agent policy, and checked a third time by an explicit
`hasPermission` guard in its handler. Parameters cannot supply or override the
actor user ID or role.

| Console capability | Administrator tools | Root-only tools |
| --- | --- | --- |
| Users | `admin.user.list`, `admin.user.suspend`, `admin.user.restore` | `root.user.role.set` |
| Templates | `admin.template.list`, `admin.template.review.list`, `admin.template.approve`, `admin.template.reject`, `admin.template.deactivate` | Same administrator tools |
| Content moderation | `admin.content.delete`, `admin.community.hide`, `admin.community.restore`, `admin.community.feature` | Same tools, including administrator-content targets allowed by the existing service policy |
| Subscription plans | `admin.subscription-plan.list/create/update/deactivate` | Same administrator tools |
| Permanent point packages | `admin.point-package.list/create/update/deactivate` | Same administrator tools, plus `root.point-package.refund` for refunds |
| Administrative recycle bin | `admin.recycle.list`, `admin.recycle.restore-request` | `admin.recycle.list`, `root.recycle.restore-approve`, `root.recycle.restore-reject` |
| MCP | `admin.mcp.server.list`, `admin.mcp.tool.list`, `admin.mcp.tool.upsert` | `root.mcp.provider.list`, `root.mcp.server.list/register/status`, `root.mcp.audit.list`, plus administrator MCP tools |
| Visual parameters | `admin.visual-parameter.list/create/update/deactivate` | Same administrator tools |
| Agent Skills | `admin.skill.list/create/update/deactivate` | Same administrator tools; root filesystem Skills remain server-file-only |
| Model catalog/routing | None | `root.model.list/create/update/deactivate`, `root.model-route.list/create/update/deactivate` |
| Execution governance | None | `root.execution-policy.list/update` |
| Audit and emergency review | None | `root.audit.list`, `root.private-content.review` |

Additional privileged invariants:

- The configured fixed root remains immutable because user suspension and role
  handlers delegate to `assertRootTargetMutable`-protected services.
- Administrator deletion uses the existing administrative recycle-bin policy;
  no permanent-delete Agent tool is registered.
- An administrator cannot suspend another administrator or manage that
  administrator's content. Root-only service rules remain authoritative.
- Payment and refund operation classes are unchanged and always require an
  explicit one-time approval, including Full Access mode.
- MCP OAuth client-secret configuration is deliberately excluded from Agent.
  User OAuth authorization remains bound to each user's own browser session.
