// DynamoDB Local has no automatic Lambda stream consumer. Keep a process-local
// snapshot and deliver changed records to the deployed dispatcher. A failed
// delivery retains the old image for retry; restart replays existing records.
import { marshall } from "@aws-sdk/util-dynamodb";

export function createLocalDuplicateStream(dispatch) {
  let previous = new Map();
  let sequence = 0;
  return async (items) => {
    const next = new Map();
    for (const item of items) {
      if (
        !item.pk?.startsWith("SITE#") ||
        !(
          /^CHECK#[^#]+#(?:ART|ANALYSIS)#[^#]+$/.test(item.sk ?? "") ||
          /^(TASK|DUP_OBSERVATION|DUP_LINK|DUP_OVERRIDE)#/.test(item.sk ?? "")
        )
      )
        continue;
      const key = JSON.stringify([item.pk, item.sk]);
      const old = previous.get(key);
      if (JSON.stringify(old) === JSON.stringify(item)) {
        next.set(key, item);
        continue;
      }
      const record = {
        eventName: old ? "MODIFY" : "INSERT",
        eventSource: "aws:dynamodb",
        dynamodb: {
          SequenceNumber: String(++sequence),
          NewImage: marshall(item, { removeUndefinedValues: true }),
          ...(old
            ? { OldImage: marshall(old, { removeUndefinedValues: true }) }
            : {}),
        },
      };
      const result = await dispatch({ Records: [record] });
      if (result?.batchItemFailures?.length) {
        if (old) next.set(key, old);
      } else next.set(key, item);
    }
    previous = next;
  };
}
