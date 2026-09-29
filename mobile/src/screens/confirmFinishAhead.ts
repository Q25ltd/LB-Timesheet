/**
 * The one confirmation for a finish more than 15 minutes ahead of now
 * (`finishAheadOf`, D40) — the same words in Finish Shift and Edit Timesheet.
 *
 * Friendly and short: it asks whether this is the time the driver means. It
 * never says the time is wrong or not allowed, and it never changes it.
 * **Go Back** leaves everything as entered; **Use This Time** goes on with
 * exactly the time given. Answered once, however it is dismissed.
 */
import { Alert } from "react-native";
import { finishAheadOf } from "../shift/finishAhead";
import { calendarDaysBetween, formatClockTime, formatDateTime, formatDuration } from "./format";

/** "You entered 16:00, which is 1 h 18 min from now. Is this the finish time you want to record?" */
function finishAheadMessage(endedAt: Date, now: Date): string {
  const at = endedAt.toISOString();
  const when = calendarDaysBetween(now.toISOString(), at) === 0 ? formatClockTime(at) : formatDateTime(at);
  return `You entered ${when}, which is ${formatDuration(now.toISOString(), at)} from now. Is this the finish time you want to record?`;
}

/**
 * Ask, when the finish is far enough ahead; `true` when asked. `now` must be
 * read at the press — never kept from when the screen opened.
 */
export function confirmFinishAhead(endedAt: Date, now: Date, onUse: () => void, onBack: () => void): boolean {
  if (finishAheadOf(endedAt, now) === null) return false;
  let answered = false;
  const once = (then: () => void) => () => {
    if (answered) return;
    answered = true;
    then();
  };
  Alert.alert(
    "Finish time is ahead",
    finishAheadMessage(endedAt, now),
    [
      { text: "Go Back", style: "cancel", onPress: once(onBack) },
      { text: "Use This Time", onPress: once(onUse) },
    ],
    { cancelable: true, onDismiss: once(onBack) },
  );
  return true;
}
