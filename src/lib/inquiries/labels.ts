export const INQUIRY_CHANNELS = [
  "phone",
  "sms",
  "walk_in",
  "facebook",
  "other",
] as const;
export type InquiryChannel = (typeof INQUIRY_CHANNELS)[number];

export const CHANNEL_LABELS: Record<InquiryChannel, string> = {
  phone: "Phone",
  sms: "SMS",
  walk_in: "Walk-in",
  facebook: "Facebook",
  other: "Other",
};

export const INQUIRY_STATUSES = ["pending", "confirmed", "dropped"] as const;
export type InquiryStatus = (typeof INQUIRY_STATUSES)[number];

export const STATUS_LABELS: Record<InquiryStatus, string> = {
  pending: "Pending",
  confirmed: "Confirmed",
  dropped: "Dropped",
};
