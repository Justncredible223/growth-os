# Master checklist (2026-10-11, branch feat/live-growth-engine; PR #188 and #189 are merged to master, this branch is not pushed)

Legend: V verified, I implemented not verified live, P partial, B blocked by a dependency, N not implemented, A needs operator approval

## Phase 1: discovery and docs
| Item | Status | Evidence |
|---|---|---|
| Architecture audit | V | ARCHITECTURE_AUDIT.md |
| Plan, checklist, operations, attribution, cost, distribution docs | V | this folder |

## Phase 2: show identity and rundown
| Item | Status | Notes |
|---|---|---|
| Host persona (futures + Fillbook scope, AI identity, no advice, no invented results) | I | persona rules 12-15; unit tests only, not heard live |
| Configurable 7-block rundown with overrun pool, topic rotation, cross-episode tiebreak | I | `showRundownConfig.ts`, `liveHostRundown.ts`, 6 unit tests, 3 handler tests |
| Rundown only runs for a real audience (2+ chatters), one viewer gets answers | I | handler tests |
| Show title "FILLBOOK LIVE: THE TRADING DESK" | N | stage still says "Fillbook Live with Tilt"; naming is the owner's call |

## Phase 3: reliability and operator control
| Item | Status | Notes |
|---|---|---|
| Bounded exponential backoff on server failures | I | `tickDelayMs`, tested |
| Overlap prevention, duplicate suppression, bounded queues | V | existing guards and tests (unique message index, backlog limit) |
| Health endpoint, failure overlay "Technical interruption" | I | not exercised against a real outage |
| Control panel: pause, mute, interrupt, skip, topic, chat off, promos off, emergency stop | I | `control.html`; control state logic tested; buttons not clicked against a live worker |
| Auth on controls | P | local bind, host/origin check, header, optional token; no per-user auth (single-operator laptop) |
| Stream-disconnect honesty | P | worker never reports live with the switch off or after an emergency stop; OBS dropped-frame state not surfaced |
| Stale market data detection | N/A | no real market data is shown; the chart is labeled simulated |

## Phase 4: visuals
| Item | Status | Notes |
|---|---|---|
| Vertical layout clear of the YouTube phone chat overlay | V | user's phone screenshot |
| Horizontal 16:9 layout (`LIVE_HOST_LAYOUT=wide`) | P | rendered in a browser preview in demo mode; not checked on a live stream |
| 11 scenes | P | label, accent and product panel chosen by segment; "chart analysis" has no real chart source so it is never used; poll has no live tally |
| Labeled simulated chart, no invented prices | V | label always on |

## Phase 5: chat
| Item | Status | Notes |
|---|---|---|
| Question priority, dedupe, one per person per line | I | handler logic; light test coverage |
| Spam and rate limit | V | TikTok spam watch (existing, tested); YouTube relies on dedupe and screening |
| Prompt-injection screening | V | 5 attack strings blocked, tested |
| Quiet-period behavior | I | silent idle moves and feature cards; no talking to an empty room |

## Phase 6-7: product and attribution
| Item | Status | Notes |
|---|---|---|
| Product claims limited to the verified list | I | persona block from the owner-verified manifest; real screens labeled EXAMPLE DATA |
| Tracked links per placement | I | `liveHostLinks.ts`, tested; landing visit not yet checked end to end |
| Platform metrics (impressions, retention) | B | needs YouTube Analytics OAuth by the owner |
| Activation definition | V | `activation_insight_delivered`, `first_trade_logged` exist on the site |
| Episode report with change notes | I | `live-host:report`, new API action `report`; needs the deploy |

## Phase 8-9: clips and distribution
| Item | Status | Notes |
|---|---|---|
| Recording | I | `LIVE_HOST_RECORD=on` starts and stops OBS recording; not run |
| Clip candidates, scores, captions (estimated timing), tracking links | I | `live-host:clips`, 8 tests; not run on a real recording |
| Publishing | A | not built on purpose: queue is `pending_approval` |
| Distribution plan, pre and post checklists | V | DISTRIBUTION.md, OPERATIONS.md |

## Phase 10-11: tests and cost
| Item | Status | Notes |
|---|---|---|
| Live Host tests | V | 230 pass in `test/liveHost*`, tsc clean |
| Whole backend suite | P | 2485 of 2487 pass; 2 `api/run-campaign` tests time out only under full-suite load and pass alone |
| Real platform integrations (YouTube chat, OBS, voice) | N | mocks only; only the first live exercised them |
| Cost doc | V | COST_AND_LIMITS.md (measured vs assumed marked) |

## Approval-gated, not done
Push and merge of this branch; deploy; any public publishing; YouTube Analytics OAuth; renaming the show.
