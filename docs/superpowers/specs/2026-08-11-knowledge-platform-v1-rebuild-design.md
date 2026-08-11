# Knowledge Platform V1 Rebuild Design

**Status:** Approved in conversation on 2026-08-11

## 1. Goal

Rebuild the current workspace from scratch as a locally runnable Knowledge Platform V1 that demonstrates three complete business loops:

1. Source material becomes reviewed enterprise knowledge.
2. Active enterprise knowledge produces cited answers.
3. Negative feedback becomes a repair task and updates knowledge.

The system must run without Feishu credentials, a production LLM, OpenSearch, Redis, or a document-processing service. Those systems are represented by explicit adapter interfaces so they can replace local adapters later without changing domain rules or page behavior.

## 2. Rebuild Policy

The existing implementation is not a migration source and will not be reused as application code.

Before rebuilding:

1. Stop all local development and visual-companion processes that use the workspace.
2. Copy the complete `KnowledgeBase` directory to the sibling directory `KnowledgeBase-backup-20260811`.
3. Include source, documentation, hidden files, `node_modules`, `dist`, and build caches in the backup.
4. Verify the backup with source/destination file counts, total byte counts, and a recursive comparison.
5. Clear the current workspace only after verification succeeds.
6. Restore this approved design and its implementation plan from the backup into the new project documentation tree.

The backup is the recovery point. The rebuild must not modify or delete it.

## 3. Product Principles

1. **Chat first for employees.** Ordinary employees see Knowledge AI, not governance complexity.
2. **Exceptions only for owners.** Knowledge Owner and Admin users process reviewable exceptions instead of manually organizing every source.
3. **Every formal fact has evidence.** A Knowledge record cannot become active without a primary source and source locator.
4. **LLM proposes; humans decide.** Automated services can extract, classify, compare, summarize, and recommend. They cannot directly publish or alter formal knowledge.
5. **Runtime details stay hidden.** Users do not configure chunks, embeddings, retrieval scores, prompts, tools, or agents.
6. **Keep the V1 domain small.** New requirements must first be expressed with Asset, Candidate, Knowledge, Review, or Conversation before adding another domain object.

## 4. Users and Permissions

### Employee

- Use Knowledge AI chat.
- Upload session files.
- Open permitted citations.
- Submit answer feedback.
- Cannot see Knowledge Factory navigation or routes.

### Knowledge Owner

- Use Knowledge AI chat.
- Open Knowledge Factory.
- See reviews assigned to the current user.
- Review related assets and knowledge.
- Submit changes to knowledge they own.

### Admin

- Use all Employee and Owner capabilities.
- See all assets, reviews, and knowledge.
- Change Owner and Authority.
- Retry parsing or indexing.

V1 does not build authentication. A local demo identity selector switches among one seeded Employee, Owner, and Admin. The server still enforces role checks so permission behavior is testable and is not only a hidden-navigation effect.

## 5. Information Architecture

Knowledge AI and Knowledge Factory share one application but present two distinct product surfaces.

### Routes

| Route | View | Access |
| --- | --- | --- |
| `/chat` | New-chat empty state and active conversation workspace | Employee, Owner, Admin |
| `/factory` | Workbench | Owner, Admin |
| `/factory/assets` | Asset list | Owner, Admin |
| `/factory/assets/:assetId` | Asset detail | Assigned Owner, Admin |
| `/factory/reviews` | Review list | Assigned Owner, Admin |
| `/factory/reviews/:reviewId` | Review detail | Assigned Owner, Admin |
| `/factory/knowledge` | Knowledge list | Owner, Admin |
| `/factory/knowledge/:knowledgeId` | Knowledge detail | Related Owner, Admin |

The shared conversation described the scope as seven pages, but its route list contains eight routed views after merging the Knowledge AI home and chat workspace into `/chat`. V1 implements the eight routes above rather than preserving the incorrect count.

## 6. System Architecture

```text
React Web
  |-- Knowledge AI
  `-- Knowledge Factory
          |
          v
HTTP Application API
  |-- Asset Intake Service
  |-- Candidate Extraction Service
  |-- Review Resolution Service
  |-- Knowledge Publishing Service
  `-- Conversation and Feedback Service
          |
          v
Pure Domain Core
  Asset | Candidate | Knowledge | Review | Conversation
          |
          v
Ports
  Repository | Document Processor | Knowledge Extractor
  Knowledge Comparator | Retrieval | Answer Generator | Indexer
          |
          v
V1 Local Adapters
  Atomic JSON Repository | Deterministic AI Adapter | Local Retrieval Adapter

Future Adapters
  Feishu Bitable/Docs/Drive | Production LLM | OpenSearch | Redis
```

### Technology

- React, TypeScript, Vite, React Router, and lucide-react for the web application.
- TypeScript on Node.js for the API.
- Fastify for HTTP routing and testable request injection.
- Zod at API boundaries for request and persisted-data validation.
- A prefixed ULID library for stable business IDs.
- Vitest and Testing Library for domain, server, and UI tests.
- Playwright-compatible browser verification for the final flows and responsive layouts.

Domain modules are pure TypeScript and do not import React, Fastify, filesystem APIs, or adapter implementations.

## 7. Domain Model

### Shared Values

```text
Authority: L0 | L1 | L2 | L3
Risk: LOW | MEDIUM | HIGH
```

Business identifiers are stable and independent from any adapter record ID:

```text
AST-{ULID}  Asset
KCD-{ULID}  Candidate
KNW-{ULID}  Knowledge
RVW-{ULID}  Review
CVS-{ULID}  Conversation
```

All timestamps are ISO 8601 UTC strings in persisted data. The UI localizes them for Asia/Shanghai.

### Asset

An Asset is one original business information source, not a chunk or a formal fact.

Core fields:

- `id`, `title`, `assetType`, `businessType`
- `provider`, `externalId`, `sourceUrl`
- `ownerId`, `authority`
- `processStatus`, `summary`, `contentHash`, `errorMessage`
- `sourceModifiedAt`, `processedAt`, `createdAt`, `updatedAt`
- `isSessionAsset`, `expiresAt`
- `sections[]` containing `id`, `title`, `locator`, and `excerpt`

Enums:

```text
AssetType: DOCUMENT | AUDIO | VIDEO | IMAGE
BusinessType:
  PRODUCT_DOCUMENT | SOLUTION | POLICY | PROCESS | TRAINING
  CUSTOMER_MEETING | INTERNAL_MEETING | PROJECT_DOCUMENT
  SESSION_UPLOAD | OTHER
ProcessStatus: NEW | PROCESSING | PROCESSED | FAILED
```

Rules:

- Authority is assigned by source policy or an Admin, never autonomously upgraded by AI.
- A session asset defaults to `SESSION_UPLOAD`, `L0`, and an expiry date.
- A changed source is reprocessed only when its content hash changes.
- Parse failure retains the Asset and records an actionable error.

### Candidate

A Candidate is one atomic fact proposed from an Asset.

Core fields:

- `id`, `title`, `content`, `knowledgeType`
- `sourceAssetId`, `sourceLocator`, `sourceExcerpt`
- `authority`, `confidence`
- `relation`, `existingKnowledgeId`, `aiReason`
- `status`, `reviewRequired`, `reviewerId`, `candidateHash`
- `createdAt`, `reviewedAt`

Enums:

```text
KnowledgeType:
  PRODUCT_CAPABILITY | PRODUCT_PARAMETER | TECHNICAL | FAQ
  PROCESS | POLICY | BEST_PRACTICE | PROJECT | OTHER
Relation: NEW | DUPLICATE | UPDATE | CONFLICT
CandidateStatus: PENDING | APPROVED | REJECTED
```

Rules:

- Authority is inherited from the source Asset and cannot exceed it.
- `sourceExcerpt` and `sourceLocator` are required.
- `existingKnowledgeId` is required for DUPLICATE, UPDATE, and CONFLICT.
- A DUPLICATE with confidence at least `0.90` is automatically rejected without a Review.
- A lower-confidence DUPLICATE and every NEW, UPDATE, or CONFLICT create a Review.

### Knowledge

A Knowledge record is one currently recognized enterprise fact.

Core fields:

- `id`, `title`, `content`, `category`, `tags`
- `authority`, `ownerId`
- `primaryAssetId`, `supportingAssetIds`, `sourceLocator`
- `status`, `version`, `validFrom`, `validTo`
- `lastVerifiedAt`, `staleReason`, `aiEnabled`, `indexStatus`
- `createdAt`, `updatedAt`

Enums:

```text
KnowledgeStatus: ACTIVE | STALE | ARCHIVED
IndexStatus: PENDING | INDEXED | FAILED
```

Rules:

- Formal knowledge must have an Owner, primary Asset, and source locator.
- Authority cannot exceed the primary Asset's Authority.
- Only `ACTIVE`, `aiEnabled=true`, and `indexStatus=INDEXED` records are eligible for ordinary answers.
- STALE defaults to `aiEnabled=false`.
- ARCHIVED requires `aiEnabled=false`.
- Updates increment `version` and preserve the change in Review history.
- A Knowledge record should express one independently verifiable proposition.

### Review

A Review is a human decision task and the V1 knowledge change log.

Core fields:

- `id`, `title`, `triggerType`, `reviewType`
- `candidateId`, `targetKnowledgeId`
- `risk`, `currentSnapshot`, `proposedContent`, `aiSuggestion`
- `reviewerId`, `status`, `resolutionAction`
- `finalContent`, `decisionComment`
- `conversationId`, `feedbackType`, `feedbackText`
- `createdAt`, `dueAt`, `resolvedAt`

Enums:

```text
TriggerType: CANDIDATE | USER_FEEDBACK | LIFECYCLE | SOURCE_CHANGE
ReviewType: NEW | UPDATE | CONFLICT | STALE
ReviewStatus: PENDING | RESOLVED | CANCELLED
ResolutionAction:
  CREATE_KNOWLEDGE | UPDATE_KNOWLEDGE | KEEP_CURRENT
  REJECT_CANDIDATE | ARCHIVE_KNOWLEDGE | CONFIRM_VALID
FeedbackType: WRONG | OUTDATED | MISSING | CITATION_ERROR | OTHER
```

The source conversation's original decision enum omitted the Conflict UI action “create new knowledge.” V1 uses explicit `ResolutionAction` values rather than the ambiguous APPROVE value.

Allowed resolution matrix:

| Review type | Allowed actions |
| --- | --- |
| NEW | CREATE_KNOWLEDGE, REJECT_CANDIDATE |
| UPDATE | UPDATE_KNOWLEDGE, KEEP_CURRENT, REJECT_CANDIDATE |
| CONFLICT | CREATE_KNOWLEDGE, UPDATE_KNOWLEDGE, KEEP_CURRENT, REJECT_CANDIDATE |
| STALE | UPDATE_KNOWLEDGE, CONFIRM_VALID, ARCHIVE_KNOWLEDGE |

The server rejects every action outside this matrix.

Resolution effects are explicit:

- CREATE_KNOWLEDGE approves the Candidate and creates a new version-1 Knowledge record. In a CONFLICT Review, the existing Knowledge remains unchanged.
- UPDATE_KNOWLEDGE writes `finalContent`, increments the target Knowledge version, updates verification time, and approves the Candidate when one exists.
- KEEP_CURRENT leaves the target Knowledge unchanged and rejects the Candidate as “valid evidence not adopted as the current enterprise fact.”
- REJECT_CANDIDATE leaves Knowledge unchanged and rejects the Candidate as invalid, irrelevant, or insufficiently supported.
- ARCHIVE_KNOWLEDGE sets `ARCHIVED`, disables AI use, and records the reason.
- CONFIRM_VALID restores or retains `ACTIVE`, enables AI use, updates verification time, and clears the stale reason.

### Conversation

A Conversation is lightweight business metadata, not the technical message database.

Core fields:

- `id`, `title`, `userId`, `topic`, `scope`, `summary`
- `sessionAssetIds`, `status`
- `messageCount`, `negativeFeedbackCount`, `hasOpenIssue`
- `lastFeedbackType`, `lastFeedbackText`
- `createdAt`, `lastActiveAt`

Enums:

```text
ConversationScope: ENTERPRISE | SESSION | BOTH
ConversationStatus: ACTIVE | ARCHIVED
MessageRole: USER | ASSISTANT
```

Conversation messages and citations use a separate repository collection keyed by Conversation ID. The local adapter may store both collections in one physical JSON file, but their interfaces remain separate. A future Feishu adapter maps Conversation metadata to Bitable and transcript content to Feishu Docs.

## 8. Application Services

### Asset Intake

1. Create an Asset with stable ID and source policy.
2. Calculate the content hash.
3. Move `NEW -> PROCESSING`.
4. Invoke the Document Processor port.
5. On success, save sections and summary, then move to PROCESSED.
6. On failure, move to FAILED and retain the error for retry.

Local V1 genuinely extracts UTF-8 text and Markdown files. Seed fixtures exercise document, spreadsheet, video, and image scenarios. Arbitrary unsupported binary files fail visibly rather than pretending they were parsed.

### Candidate Extraction and Comparison

1. Processed Asset sections are passed to the deterministic Knowledge Extractor.
2. Candidate hashes prevent duplicate extraction from the same source.
3. Local Retrieval finds related ACTIVE Knowledge.
4. The deterministic Comparator sets relation, target, confidence, and reason.
5. Routing rules auto-reject high-confidence duplicates or create Reviews.

### Review Resolution

1. Load Review, Candidate, target Knowledge, and primary Asset in one service operation.
2. Validate role, Review state, resolution matrix, required content, ownership, and Authority.
3. Apply the selected domain transition.
4. Mark the Review RESOLVED and Candidate APPROVED or REJECTED as appropriate.
5. Queue indexing by setting Knowledge `indexStatus=PENDING`.
6. Persist the complete operation atomically.

### Knowledge Answering

1. Resolve Conversation Scope.
2. Retrieve only permitted ACTIVE and AI-enabled Knowledge plus prepared Session Assets.
3. Produce a deterministic answer and citations.
4. Persist the user and assistant messages after the complete answer is available.
5. Update Conversation counts, title, topic, summary, and last-active time.

No-token streaming is required for the deterministic local adapter. The API shape keeps a future streaming endpoint possible without changing stored message semantics.

### Feedback Repair

1. Persist feedback on the assistant message.
2. Update Conversation feedback counts and latest-feedback fields.
3. If the cited Knowledge is known, create a USER_FEEDBACK Review assigned to its Owner.
4. OUTDATED and citation-integrity feedback produce STALE review tasks; clearly wrong cited facts produce CONFLICT review tasks.
5. If no Knowledge target can be resolved, mark the Conversation as having an open issue without inventing a target Review.

## 9. Persistence and Adapters

The local repository stores data in `data/knowledge-platform.json` with separate top-level collections for users, assets, candidates, knowledge, reviews, conversations, and messages.

Requirements:

- Validate the complete document on load.
- Serialize writes through one in-process queue.
- Write to a temporary file in the same directory and rename atomically.
- Never expose adapter record IDs as domain IDs.
- Seed data only when the file does not exist.
- Provide an explicit demo reset operation restricted to Admin.

Future adapter boundaries:

| Port | Local V1 | Future |
| --- | --- | --- |
| Business repository | Atomic JSON | Feishu Bitable |
| Conversation transcript | JSON message collection | Feishu Docs |
| Original asset | Local fixture/reference | Feishu Drive/Wiki/Docs |
| Document processing | Text/Markdown + deterministic fixtures | OCR/ASR/document service |
| Extraction/comparison/answer | Deterministic rules | Production LLM |
| Retrieval/indexing | In-memory lexical retrieval | OpenSearch |
| Cache | None | Redis |

## 10. HTTP API Surface

The API is resource-oriented and uses domain actions only where a state transition is required.

```text
GET    /api/health
GET    /api/session
PUT    /api/session/role

GET    /api/assets
POST   /api/assets
GET    /api/assets/:assetId
POST   /api/assets/:assetId/process

GET    /api/reviews
GET    /api/reviews/:reviewId
POST   /api/reviews/:reviewId/resolve

GET    /api/knowledge
GET    /api/knowledge/:knowledgeId
POST   /api/knowledge/:knowledgeId/request-update
POST   /api/knowledge/:knowledgeId/reindex

GET    /api/conversations
POST   /api/conversations
GET    /api/conversations/:conversationId
POST   /api/conversations/:conversationId/messages
POST   /api/conversations/:conversationId/messages/:messageId/feedback
POST   /api/conversations/:conversationId/archive

POST   /api/demo/reset
```

All error responses use a stable shape:

```json
{
  "error": {
    "code": "REVIEW_ACTION_NOT_ALLOWED",
    "message": "This resolution is not allowed for a NEW review.",
    "details": {}
  }
}
```

The UI maps known error codes to concise Chinese messages and uses a generic retry state for unknown failures.

## 11. Page Design

The visual direction is quiet, dense, and work-focused. It uses a neutral canvas, white work surfaces, dark ink, restrained teal for primary actions, amber for attention, and red for risk. Cards are limited to repeated records and metrics, with radii no larger than 8px. Typography uses stable sizes and zero letter spacing.

### `/chat`

- Left column: new-chat command and conversation history grouped by day.
- Center: empty composer or chronological message thread and sticky composer.
- Citation references appear inline and in an answer source list.
- Clicking a citation opens a right-side source drawer without leaving the conversation.
- Attachment status clearly distinguishes parsing, ready, and failed.
- Scope is a compact menu: enterprise, session, or both.
- Thumbs-up records immediately. Thumbs-down opens the feedback form.
- Session files expose “submit as enterprise material,” which creates or promotes an Asset but never directly creates Knowledge.

### `/factory`

- Four operational signals only: pending review, conflict, stale, and recent processed assets.
- Priority queue sorted by risk descending, due date ascending, and creation time descending.
- No token, embedding, model-call, or generic volume dashboard.

### Asset List and Detail

- List columns: title, business type, Authority, Owner, process status, candidate count, updated time.
- Detail uses source content on the left and AI analysis/candidates on the right.
- Selecting a Candidate moves the source to its locator and highlights the excerpt.
- Admin-only actions include Authority change and retry processing.

### Review List and Detail

- List defaults to the current Owner's PENDING tasks.
- HIGH risk is always first.
- Detail renders the current formal fact, new evidence, source Authority, AI analysis, and only the allowed actions for its Review type.
- Conflict review can create a separate Knowledge record without weakening the existing fact.
- Submit is disabled until required final content and comments are present.

### Knowledge List and Detail

- List supports title/content/tag search and category, status, Authority, Owner, and updated-time filters.
- Detail shows formal content, status, Authority, Owner, version, verification date, primary evidence, supporting evidence, and Review history.
- “Edit knowledge” creates an UPDATE Review; it never directly saves over formal content.
- Archive requires a reason and results in `ARCHIVED + aiEnabled=false`.

### Responsive Behavior

- Desktop Factory uses a stable sidebar and dense content area.
- Tablet collapses secondary panels below the primary work area.
- Mobile uses a navigation drawer, single-column lists, and full-width dialogs/drawers.
- Tables switch to compact record rows rather than horizontal overflow.
- Fixed toolbars and counters have stable dimensions so loading and status changes do not shift layout.

## 12. Loading, Empty, Error, and Permission States

Every routed view defines:

- Loading skeleton that preserves the final layout.
- Empty state with one relevant next action.
- Recoverable error with retry.
- Permission state that does not reveal protected record details.
- Not-found state for missing or removed records.

Transition-specific behavior:

- Parse failure retains the Asset and exposes retry.
- Review submission remains unchanged in the UI until the server confirms the atomic transition.
- Index failure does not roll back approved knowledge; it marks `indexStatus=FAILED`, removes it from answers until successful indexing, and exposes Admin retry.
- Unsupported session files never enter the answer context.

## 13. End-to-End Flows

### Source to Knowledge

1. Admin imports a sample or text Asset.
2. The system processes it and creates Candidates.
3. Duplicate Candidates are rejected by rule when appropriate.
4. NEW, UPDATE, and CONFLICT Candidates appear in the Review queue.
5. Owner resolves a Review.
6. Knowledge is created or updated with evidence and version history.
7. Indexing marks it INDEXED and makes it eligible for answers.

### Knowledge to Answer

1. Employee creates a Conversation.
2. Employee asks a question.
3. Retrieval considers only permitted, ACTIVE, AI-enabled, indexed Knowledge.
   In V1, all authenticated Chat roles may consume this formal enterprise Knowledge. Authority ranks evidence reliability; it is not an access-classification level.
4. The answer includes citations and source excerpts.
5. Employee opens the source drawer and continues the conversation.

### Error to Repair

1. Employee marks a cited answer as outdated.
2. Feedback updates the Conversation and creates a USER_FEEDBACK STALE Review.
3. The Knowledge Owner resolves the Review.
4. Knowledge is updated, confirmed valid, or archived.
5. The changed fact is reindexed and future answers use the new state.

## 14. Testing Strategy

### Domain Unit Tests

- Every state transition and forbidden transition.
- Authority inheritance and upper-bound rules.
- Review resolution matrix.
- Active-answer eligibility.
- Candidate duplicate threshold and Review routing.
- Feedback-to-Review mapping.

### Repository and API Tests

- Seed-on-first-start behavior.
- Persist/reload equivalence.
- Atomic write behavior and invalid-file rejection.
- API validation and stable error shape.
- Role enforcement for every protected route.
- Multi-record Review resolution transaction.

### UI Interaction Tests

- All eight routes render their loading, data, empty, error, and permission states.
- Chat persists multi-turn history and opens citation evidence.
- Asset Candidate selection synchronizes source evidence.
- Review forms expose only valid actions and update the visible result after confirmation.
- Knowledge detail shows version and Review history.
- Employee navigation never exposes Factory.

### Browser Verification

- Run the three end-to-end flows against the real local frontend and API.
- Check desktop and mobile viewports for overflow, text clipping, layout shifts, and overlapping controls.
- Verify no console errors and no failed application requests.
- Confirm that a page refresh retains the current data.

## 15. Acceptance Criteria

The rebuild is complete when:

1. A clean install starts the frontend and API without external credentials.
2. All eight routes are usable and role-appropriate.
3. A sample/text Asset can move from NEW to PROCESSED and produce traceable Candidates.
4. NEW, UPDATE, and CONFLICT Reviews can be resolved with only valid actions.
5. Formal Knowledge always has Owner, primary evidence, locator, Authority, version, and status.
6. Chat answers use only eligible Knowledge and show verifiable citations.
7. Negative feedback on a cited answer creates a repair Review.
8. Resolving the repair changes what future answers use.
9. Restarting the API preserves data.
10. Domain, API, UI, build, and browser checks pass.

## 16. Explicit Non-Goals

- Production Feishu setup or credential management.
- Production LLM prompting, evaluation, or model selection.
- Arbitrary PDF/Office/image/audio/video semantic parsing.
- OpenSearch, vector embeddings, reranking, Redis, or distributed workers.
- Real authentication, SSO, or enterprise permission synchronization.
- Knowledge Graph, agent management, prompt management, workflow designer, market research, or generalized BI.
- Complex multi-stage approval, batch governance, or custom ontology builders.

## 17. Implementation Order

Implementation follows vertical business slices:

1. Safe backup, workspace reset, new project foundation, and shared domain primitives.
2. Asset intake through Candidate extraction.
3. Review resolution through Knowledge publication.
4. Knowledge AI conversation, retrieval, citation, and source drawer.
5. Feedback repair loop.
6. Role behavior, responsive polish, full verification, and handoff.

Each slice includes domain rules, repository/API behavior, UI, and tests before the next slice begins.
