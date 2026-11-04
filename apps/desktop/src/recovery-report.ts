// The wording of the interrupted-save report, as a pure function of what the
// backend handed back.
//
// This is everything the user reads about a metadata save that a crash or a
// force-quit cut short, and it carries nearly all of that feature's judgment:
// which cause may be named, which offers may be made, what a partial discard is
// allowed to claim. None of it needs a DOM, a Tauri command or a running app —
// an entry is a `RecoveryNotice` and the answer is a string — so it lives here
// and `editors.ts` keeps only the mounting and the IPC. The claims the sentences
// make are asserted in test/recovery-report.test.ts; the panel this feeds is
// `showRecoveryNotices` (editors.ts).

import type { DiscardReport, RecoveryNotice } from "./types";

const trackName = (path: string): string => path.split("/").pop() || path;
const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

// What an interrupted update did to the whole selection, not just to the file
// that was mid-write. The batch is strictly sequential and each file's library
// row is committed as it goes (write_tags_to_files), so there are exactly three
// regions and the user can't tell them apart by looking: everything before the
// interruption is saved for good, one file was being rewritten, and everything
// after it was never opened. Saying only what happened to the middle one is what
// makes the report read as "some unknown part of my edit is in limbo".
//
// Hedged to "any other tracks" because the recovery record doesn't carry the
// size of the batch it came from — it is written per file, and by the next
// launch the selection it belonged to is gone. So the sentence has to be true of
// a one-file save as well, where there are no other tracks and a flat claim
// about them would be inventing siblings. The hedge reads the same for a real
// batch and says nothing false for a single file.
const batchContext = (many: boolean): string =>
  many
    ? "Any other tracks those updates had already finished kept their new tags, and any they never reached were left as they were."
    : "Any other tracks the update had already finished kept their new tags, and any it never reached were left as they were.";

// "when Pudding stopped" is true only of a crash or a force-quit. A copy the
// writing process itself gave up on comes from a save the user watched fail and
// was told about at the time (RecoveryState::Retained), so blaming a crash would
// be telling them something that didn't happen.
//
// One sentence covers a whole group, so a cause can only be named when it is the
// cause of every entry in that group. A group holding both kinds falls back to
// the one thing true of all of them; that group is always plural, since a cause
// belongs to a single entry.
const interruption = (notices: RecoveryNotice[]): string => {
  if (notices.every((notice) => notice.crashed)) return "when Pudding stopped";
  if (notices.every((notice) => !notice.crashed))
    return "when an earlier save failed and Pudding couldn't undo it";
  return "when earlier updates were interrupted";
};

// The kept entries that still have bytes behind them. Every offer the report
// makes about a copy — retry it, discard it, warn that it's the last original —
// has to be counted from this and not from the entries, because an entry can
// outlive the copy it was created for: a record whose copy has since been
// deleted is still reported, and there is nothing left to put back.
const withCopy = (notices: RecoveryNotice[]): RecoveryNotice[] =>
  notices.filter((notice) => notice.backup !== null);

// A copy whose record was too damaged to name a track. Nothing can be said about
// which file it belongs to, so these get their own sentence rather than being
// described with a path out of Application Support where a track name goes.
const unidentified = (notices: RecoveryNotice[]): RecoveryNotice[] =>
  notices.filter((notice) => notice.target === null);

// The records a retry or a discard can be aimed at. Exported because the two
// commands take these paths and nothing else — an entry with no readable record
// has nothing for them to act on.
export const manifestPaths = (notices: RecoveryNotice[]): string[] =>
  notices
    .map((notice) => notice.manifest)
    .filter((manifest): manifest is string => manifest !== null);

// How an entry is named in a sentence. A track is named by its file; a copy whose
// record is unreadable has no track to name, and saying so is the whole point of
// keeping `target` nullable.
const label = (target: string | null): string =>
  target === null ? "A recovery copy Pudding couldn't identify" : `“${trackName(target)}”`;

function recoveryReportText(kept: RecoveryNotice[], restored: RecoveryNotice[]): string {
  if (kept.length === 0) {
    const mid =
      restored.length === 1
        ? `${label(restored[0].target)} was being rewritten ${interruption(restored)}, and has been put back the way it was before that update.`
        : `${restored.length} tracks were being rewritten ${interruption(restored)}, and have been put back the way they were before those updates.`;
    return `${mid} ${batchContext(restored.length > 1)}`;
  }

  const orphans = unidentified(kept);
  const named = kept.filter((notice) => notice.target !== null);
  const copied = withCopy(named);
  const lost = named.filter((notice) => notice.backup === null);

  const parts: string[] = [];
  if (copied.length > 0) {
    parts.push(
      copied.length === 1
        ? `${label(copied[0].target)} was being rewritten ${interruption(copied)}, and Pudding couldn't put the original back, so that file may be incomplete. A copy of the original is kept.`
        : `${copied.length} tracks were being rewritten ${interruption(copied)}, and Pudding couldn't put the originals back, so those files may be incomplete. A copy of each original is kept.`,
    );
  }
  if (lost.length > 0) {
    parts.push(
      lost.length === 1
        ? `${label(lost[0].target)} was being rewritten ${interruption(lost)}, so that file may be incomplete and its recovery copy is gone too, so Pudding has nothing left to put back.`
        : `${lost.length} tracks were being rewritten ${interruption(lost)}, so those files may be incomplete and their recovery copies are gone too, so Pudding has nothing left to put back.`,
    );
  }
  if (orphans.length > 0) {
    const also = copied.length > 0 || lost.length > 0 ? " also" : "";
    parts.push(
      orphans.length === 1
        ? `Pudding${also} kept a recovery copy from an interrupted save, but couldn't read the record of which track it belongs to.`
        : `Pudding${also} kept ${orphans.length} recovery copies from interrupted saves, but couldn't read the records of which tracks they belong to.`,
    );
  }
  if (restored.length > 0) {
    parts.push(
      restored.length === 1
        ? "One other interrupted track was put back the way it was."
        : `${restored.length} other interrupted tracks were put back the way they were.`,
    );
  }
  parts.push(batchContext(kept.length + restored.length > 1));

  // A closing instruction only where there is something to do about it, and one
  // at most. A copy that can be put back outranks a copy nobody can place,
  // because that's the only case where the original can still get back where it
  // belongs. A record whose copy is gone gets no line at all: there is nothing
  // for Pudding to offer, and how to proceed with a file that may be damaged is
  // the user's call to make on their own terms, not ours to prescribe.
  if (copied.length > 0) {
    parts.push(
      copied.length === 1
        ? "Retry the restore, or put the copy back in place yourself. It's the only original, so keep it until you're sure everything is in order."
        : "Retry the restore, or put the copies back in place yourself. They're the only originals, so keep them until you're sure everything is in order.",
    );
  } else if (orphans.length > 0) {
    parts.push(
      orphans.length === 1
        ? "The copy is at the path below; keep it until you've worked out which track it belongs to."
        : "The copies are at the paths below; keep them until you've worked out which tracks they belong to.",
    );
  }
  return parts.join(" ");
}

// One offer the report makes, named by what it does rather than by what it
// calls: the label and whether the button is there at all are assertions this
// module owns, and the handler behind it is editors.ts's to bind.
export type RecoveryButton =
  | { kind: "retry"; label: string; manifests: string[] }
  | { kind: "discard"; label: string; records: RecoveryNotice[] }
  | { kind: "dismiss"; label: string };

export type RecoveryPanel = {
  heading: string;
  message: string;
  details: string[];
  buttons: RecoveryButton[];
};

// How an action the user took reported back: the heading it earns and the one
// sentence for what it did. What `discardOutcome` and `discardRefusal` return,
// and what `recoveryPanel` states ahead of the report when it is handed one.
export type RecoveryOutcome = { heading: string; message: string };

// Whether the report still asks anything of the user. False once every offer is
// gone and all that is left is to close the panel, which is the only case where
// a caller may mount an outcome on its own: there is then nothing the report
// could have put a button on, so nothing is stranded by leaving it out.
export const recoveryOffersAction = (panel: RecoveryPanel): boolean =>
  panel.buttons.some((button) => button.kind !== "dismiss");

// `retried` is the set of records a retry just attempted, and its only job is to
// stop this panel being the panel it was clicked from. The report is rebuilt
// wholesale from what the backend hands back, so a retry that changed nothing
// renders the same heading, the same sentence and the same reason as before it
// ran — leaving the one signal that the attempt happened at all to be the
// progress panel that already flashed past.
//
// What it achieved is counted by subtraction rather than by matching entries
// back to what was sent: a restored notice carries no manifest, because there is
// nothing left to act on, and an entry the retry found already complete comes
// back as no notice at all. So the ones that moved are the ones no longer stuck.
//
// `acted` is an outcome the caller already holds — a discard that was refused or
// got through only part of its list, a retry that threw before it ran — and it
// replaces the heading and lead `retried` would have derived. The report under
// it is untouched: the entries the action didn't settle are still held, still
// unresolved, and still get their offers. That is what keeps an action that
// failed from being the end of the report.
export function recoveryPanel(
  notices: RecoveryNotice[],
  retried?: string[],
  acted?: RecoveryOutcome,
): RecoveryPanel {
  const kept = notices.filter((notice) => !notice.restored);
  const restored = notices.filter((notice) => notice.restored);
  const records = kept.filter((notice) => notice.manifest !== null);
  // Retrying resolves the record against the track it names, so an entry with no
  // readable record and an entry with no copy left are both past retrying. They
  // can still be discarded, which is the only thing left to do with them.
  const retryable = records.filter((notice) => notice.target !== null && notice.backup !== null);
  const copies = withCopy(records);

  // Each kept copy gets its reason and the path its bytes are at — the path is
  // the whole point of telling someone, since nobody goes looking in
  // Application Support on a hunch.
  const details: string[] = [];
  for (const notice of kept) {
    const name = notice.target ?? "A recovery copy Pudding couldn't identify";
    details.push(`${name}: ${notice.reason ?? "Pudding couldn't put the original back."}`);
    if (notice.backup) details.push(`Copy of the original: ${notice.backup}`);
  }
  // Listed whether or not a copy is still open. With one unresolved the restored
  // tracks are context, not the headline, so the sentence only counts them and
  // this is the one place they're named; with nothing unresolved the sentence
  // names a lone track but still can't fit several, and a restore the user never
  // asked for is exactly the case where they need to know which files on disk
  // moved under them. Either way the list is where the paths are, so it is never
  // the larger restore that says less.
  for (const notice of restored) {
    if (notice.target !== null) details.push(`${notice.target} — restored`);
  }

  const stuck = retried
    ? kept.filter((notice) => notice.manifest !== null && retried.includes(notice.manifest)).length
    : 0;
  const settled = retried ? retried.length - stuck : 0;

  const buttons: RecoveryButton[] = [];
  if (retryable.length > 0) {
    // Offered again whether or not the last attempt helped: the reason a copy is
    // stuck is usually storage that hasn't come back yet, and that can change
    // between one press and the next.
    buttons.push({
      kind: "retry",
      label: retried ? "Retry again" : "Retry restore",
      manifests: manifestPaths(retryable),
    });
  }
  if (records.length > 0) {
    // Nothing to throw away but the records themselves once their copies are
    // gone, and clearing those is not the same offer as deleting an original.
    // A set holding both kinds is named by neither: any count here would be a
    // count of one kind standing in for the whole button, so it goes without
    // one and the confirmation spells out what goes.
    const label =
      copies.length === 0
        ? plural(records.length, "Clear record", "Clear records")
        : copies.length === records.length
          ? plural(copies.length, "Discard copy", "Discard copies")
          : "Discard";
    buttons.push({ kind: "discard", label, records });
  }
  buttons.push({ kind: "dismiss", label: kept.length > 0 ? "Dismiss" : "Done" });

  // Said first and in the retry's own terms, because after a retry that is the
  // question the panel is answering; the account of what is left follows it
  // unchanged. Nothing here claims a track was put back — a settled entry is one
  // the backend stopped reporting, which is the restore in every case a retry
  // can reach, but the heading rests on it having been settled either way.
  const retryOutcome = !retried
    ? null
    : stuck === 0
      ? {
          heading: plural(settled, "That entry is settled", "Those entries are settled"),
          lead: "",
        }
      : settled === 0
        ? {
            heading: "The retry didn't help",
            lead: `${plural(stuck, "That entry is", "Those entries are")} in the same state as before it ran.`,
          }
        : {
            heading: "The retry settled some of them",
            lead: `${settled} of ${retried.length} are resolved; the ${plural(stuck, "other is", "others are")} unchanged.`,
          };

  // An outcome the caller was handed outranks one derived from the entries. A
  // refused discard and a retry that threw are facts about the call, and they
  // leave the entries looking exactly as they did before it — which the
  // subtraction above would read as a retry that changed nothing, and say so,
  // over an action that wasn't a retry.
  const preface = acted ? { heading: acted.heading, lead: acted.message } : retryOutcome;

  return {
    heading:
      preface?.heading ??
      (kept.length > 0 ? "A metadata save didn't finish" : "Recovered an interrupted save"),
    message: [preface?.lead, recoveryReportText(kept, restored)].filter(Boolean).join(" "),
    details,
    buttons,
  };
}

// What the discard's messages are *about*: the copies where there are any, since
// those are what the user agreed to lose, and the bare records only when they are
// all there is. One copy travelling with two copy-less records is not three
// copies, so every count below comes from this split rather than from the total.
function discardSubject(records: RecoveryNotice[]): {
  noun: [string, string];
  counted: number;
  copies: number;
  bare: number;
  attempted: number;
} {
  const copies = withCopy(records).length;
  return {
    noun: copies === 0 ? ["record", "records"] : ["copy", "copies"],
    counted: copies === 0 ? records.length : copies,
    copies,
    bare: records.length - copies,
    // The denominator of a partial, and not the same number as `records.length`:
    // only the entries with a record to name were sent, so only they could have
    // gone. Derived here rather than passed in so it cannot disagree with the
    // list the command was actually given.
    attempted: manifestPaths(records).length,
  };
}

// A discard that achieved nothing: the command refused the paths outright, every
// pair failed, or the call itself threw. Counted like the other two outcomes —
// this is reached with a whole selection refused just as often as with one, and a
// heading that says "the recovery copy" over three of them reads as though only
// one was at stake.
//
// `message` is what the backend said went wrong. Omitted for a failure that
// carried no sentence of its own — a rejected call rather than a refused
// unlink — where all there is to say is what didn't happen.
export function discardRefusal(records: RecoveryNotice[], message?: string): RecoveryOutcome {
  const { noun, counted } = discardSubject(records);
  const one = plural(counted, noun[0], noun[1]);
  return {
    heading: `Couldn't discard the recovery ${one}`,
    message: message ?? `Couldn't remove the recovery ${one}.`,
  };
}

// The three outcomes of a discard, worded apart. The pairs are removed one at a
// time, so "some of them went" is a real outcome and not an edge case.
export function discardOutcome(report: DiscardReport, records: RecoveryNotice[]): RecoveryOutcome {
  const { noun, counted, copies, bare, attempted } = discardSubject(records);
  if (report.failure !== null) {
    // The one thing this must never say is that nothing happened. Whatever went
    // is unlinked, and for a copy that was the last original bytes anywhere, so
    // a partial discard is reported as the partial loss it is.
    //
    // Counted off the whole set, which is why the noun can't come from the
    // split: a count of a set that was all copies names copies however it lands,
    // but which kind survived a mixed set isn't knowable from a total, and
    // calling them all copies there is the overcount the split exists to avoid.
    // So a mixed set is counted in entries and neither kind stands in for the
    // other.
    if (report.discarded > 0) {
      const sets = copies > 0 && bare > 0 ? "entries" : noun[1];
      return {
        heading: "Couldn't discard all of them",
        message: `${report.discarded} of ${attempted} recovery ${sets} are gone for good; the rest are still in place. ${report.failure}`,
      };
    }
    return discardRefusal(records, report.failure);
  }
  const one = plural(counted, noun[0], noun[1]);
  const verb = counted > 1 ? "are" : "is";
  const also =
    copies > 0 && bare > 0
      ? ` ${bare === 1 ? "A record" : `${bare} records`} with no copy left ${bare === 1 ? "was" : "were"} cleared too.`
      : "";
  return {
    heading: `Recovery ${one} discarded`,
    message: `The ${one} ${verb} gone.${also}`,
  };
}

// The native confirmation, which is the last thing between the user and the only
// copy of an original. Named after the track where there is a track to name: a
// copy whose record is unreadable can only be described as what it is.
//
// Null where there is nothing to confirm. Records whose copies are already gone
// hold nothing to lose, so a confirmation over them would protect nothing and
// ask the user to agree to a deletion that isn't one. They are still named in
// the warning when they travel with a copy, because the button removes them too
// and a confirmation that undercounts what it deletes isn't one.
export function discardConfirmation(
  records: RecoveryNotice[],
): { title: string; message: string } | null {
  const copies = withCopy(records);
  if (copies.length === 0) return null;
  const bare = records.length - copies.length;
  const many = copies.length > 1;
  const only = copies[0].target;
  const what = many
    ? `${copies.length} recovery copies`
    : only !== null
      ? `the recovery copy of ${trackName(only)}`
      : "a recovery copy Pudding couldn't match to a track";
  const caveat = many
    ? "Those tracks may still be incomplete on disk, and these are the only copies of the originals."
    : only !== null
      ? "That track may still be incomplete on disk, and this is the only copy of the original."
      : "Some track may still be incomplete on disk, and this is the only copy of its original.";
  // Mentioned, not warned about: these hold no bytes, so they belong in the
  // account of what the button removes and not in the caveat about originals.
  const rest =
    bare === 0
      ? ""
      : bare === 1
        ? " It also clears one record whose copy is already gone."
        : ` It also clears ${bare} records whose copies are already gone.`;
  return {
    title: many ? "Discard recovery copies?" : "Discard recovery copy?",
    message: `This deletes ${what}.${rest} ${caveat}`,
  };
}
