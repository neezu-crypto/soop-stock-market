function classifyStreamerVerificationNoteNoMatch(requests, senderId, now) {
  const pendingForSender = Object.entries(requests || {}).filter(([, entry]) =>
    entry && entry.status === "pending" &&
    (entry.isSwitch === true || String(entry.soopId || "").trim().toLowerCase() === senderId),
  );
  if (!pendingForSender.length) return "no-pending-request-for-sender";
  const hasActiveCode = pendingForSender.some(([, entry]) =>
    !!entry.noteVerificationCodeHash && Number(entry.noteVerificationCodeExpiresAt) > now,
  );
  return hasActiveCode ? "code-mismatch" : "pending-request-code-missing-or-expired";
}

module.exports = { classifyStreamerVerificationNoteNoMatch };
