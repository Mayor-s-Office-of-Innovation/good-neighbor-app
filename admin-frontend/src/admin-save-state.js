/** Keep historical warnings independent of the send currently being polled. */
export function letterEmailProgress(items, jobId) {
  const history = items.filter((item) => item.type === "complianceLetterEmail");
  return {
    history,
    uncertain: items.some((item) => item.deliveryState === "uncertain"),
    currentUncertain: items.some(
      (item) =>
        item.letterJobId === jobId && item.deliveryState === "uncertain",
    ),
    sent: history.find((item) => item.sk === `LETTER_EMAIL#${jobId}`),
  };
}

/** Omit an unchanged missing phone, but let validation reject clearing one. */
export function profilePhoneUpdate(phone, previousPhone) {
  return !phone.trim() && !previousPhone ? {} : { phone };
}
