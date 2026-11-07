# The order that avoids most mistakes

Every step here exists because skipping it cost a round. The gateway does not enforce the order;
it only makes each step checkable. This document is the order, and the evidence to collect at each
step.

## Why an order

A write to an ABAP object is not a file save. It takes a lock, creates an inactive version, and
only activation makes that version real. Each of those can fail independently, and two of them fail
in ways that look like success. Working in one order—read, write once, verify, activate, verify
again—means a failure shows up at the step that caused it.

## Create an object

The create tools build a shell: the object and its metadata, without source.

- Have the whole source ready before the first call. Compose it locally, then create and write in
 one go.
- Do not write it in pieces afterwards. A shell that sits there is indistinguishable from a broken
 object, and activation will succeed on it: an empty procedure is valid, compiled code.
- Check, activate, then read the active version back and compare it with what you wrote.
- An object that other objects name—an include, a function module, a screen—needs its parent to
 exist first.

The order inside one object's creation is enough that some stacks answer "already exists" on a retry
after a partial failure. After any failure, read the object before retrying.

## Change an existing object

- Read the source first, every time. The gateway cannot patch a file it has not read, and neither can
 a person.
- Keep a copy of what you read. It is your diff base and your rollback.
- Edit that copy with a real editor, not by regenerating the whole object from memory. Output that
 you generate is paid for by the token, and a 1,800-line object will not fit in one answer.
- Upload once. Pass the expected line count (or a patch with its expected count) so a wrong file
 fails loudly instead of replacing the object with something shorter.
- Read the active version back and diff it against your copy. A `success` flag is not that diff.
- Activate, then read back again. Compare content, not timestamps.

Only one upload should happen per edit. A rejected upload means the whole source is sent again, so
fix what would be rejected before the first attempt rather than after the third.

## Prove the change landed

Evidence, strongest first:

- The active version's content equals what you wrote. This is the only proof.
- No draft is left behind (`REPOSRC.R3STATE = 'A'`). Supporting evidence: it says there is nothing
 unactivated, not that what is active is yours.
- The response field (`activated: true`, `isDeleted`, `written`). Useful, insufficient. Some responses
 mean "the request was accepted", and some stacks answer success for work that did not happen.

What does not count as proof: a read-back of the source alone (it may be the inactive draft), the
wording of a status line, the absence of a dump, a successful check, or "the object is in the list".

## Delete and prove it

Deletion claims need three things, and the second one catches most wrong claims:

- The delete response says deleted, not merely 200.
- A read of the object now answers not-found. Careful: some stacks answer a read of a deleted object
 with success and no source—that is not the same as not-found, and package content lists are not a
 delete proof either way.
- The object's row is gone from `TADIR`. For a local object in `$TMP` the row disappears at once; for
 an object in a transportable package the row stays and is marked for deletion until the transport
 is released. "Poll until the row disappears" only ever works for local objects.

Delete children before parents. An include cannot go while its main program still names it; a
function module cannot go after its group.

## Locks

- A lock handle is valid in the session that created it. One gateway session per system means
 consecutive calls land in the same ABAP session—keep them consecutive.
- Release it whatever happened. Wrap lock, write and unlock so that a failure in the middle still
 releases. An object left locked rejects every later lock request.
- Do not mix a low-level lock with a high-level write on the same object: the high-level tool takes
 its own lock.
- A handle that is truly lost can only be cleared by session timeout or by an administrator. That is
 a reason to take locks late and release them early, not a recovery plan.
- An object open in an editor tab is a session of its own and holds the same kind of lock. Close the
 tab before writing.
- The lock's *user* is the logon, not the session. `使用者 <you> 当前编辑 <object>` therefore also
 describes a session of yours that ended without unlocking — a short-lived script, a killed run. When
 closing the editor changes nothing, the entry is orphaned: filter SM12 by the object name and delete
 it. Re-locking from the gateway cannot help, because releasing needs a handle this session never had
 (measured: `LockProgramLow` answers the same `locked` while the object is `$TMP` and no tab is open).
- A process that exits while holding a lock does not release it. A concurrency experiment therefore
 belongs in one long-lived process with `try`/`finally` around the lock, never in short-lived ones that
 fire and die — four `$TMP` programs needed SM12 after exactly that mistake.
- Two writes to the same object at the same time: measured over five rounds on a `$TMP` program, the
 second call was refused every time with `locked`, and the first one's source survived — so the loss
 is loud, not silent. `Update*` still carries `concurrent_write` for the narrower window where both
 answer `written: true`; that window did not reproduce, so treat a read-back, not two successes, as
 the proof of what the object holds.
- The generation enqueue (`E_ABAP_GENPH`) is the exception: it belongs to the generation task and
 releases itself, and it is exclusive, so a standing one blocks later activations even for the same
 user. Reuse objects instead of creating, activating and deleting them in one breath.

## Transport requests

Check three things before asking anyone for a new request:

- What is already open under your name.
- Which unreleased requests name this object, and whether they hold its lock.
- Who owns those requests and what kind they are (request versus task).

If an open request of yours already covers the object, use it. If the object is locked in someone
else's request, writing into it may be accepted—that is the case where the GUI would attach
automatically. If it sits in someone's task, only the owner can help. Ask for a new request only when
none of those apply, and say which transport layer you are aiming at.

- The description must be ASCII. Non-ASCII characters land in the request as `#` and there is no tool
 to fix that afterwards.
- The response does not contain the request number as a field; it is in the `uri` of the answer. Read
 it, then fetch the request to confirm.
- A `modifiable_only` filter is not a way to tell whether a request can still take changes; check the
 request status instead.

## When a call fails

Work through these in order; each layer masks the ones below it.

| Layer | Symptom | What to try |
|---|---|---|
| lock | "currently editing", refuses every write | release the lock you hold, close the editor tab, or ask for the lock to be cleared |
| transport | "not in a request", "task not usable" | see the section above |
| session | several unrelated calls answer 400 / 401 at once, or a syntax error names something you did not touch | one read-only call to confirm, then reconnect; do not edit code in response |
| size | the upload never arrives, or the check complains about source that is visibly fine | shorten the change, or split the object |
| content | a real check error at a line you did change | fix the code |

A 2xx is not by itself proof of an ADT answer: the shape matters. The dump viewer is the one endpoint
that answers HTML on purpose (`/runtime/dump/…/summary`), every other one answers markup, and the
parsers refuse what they do not recognise (`unrecognized-response`) rather than reporting an empty
success. When a tool answers `success: true` with nothing in it, read the body shape before believing
the emptiness — a proxy or a logon page answering for the system looks exactly like that.

Two rules apply throughout. **Do not resend a call whose answer you could not read**: report the
status and the root element instead, because the second attempt costs the same and teaches nothing.
**Do not rebuild an object to get past an error**: if the rebuild is also going to fail, you now have
an empty shell instead of the original.
