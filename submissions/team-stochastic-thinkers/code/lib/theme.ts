/**
 * One pastel per bookable trade.
 *
 * Lifted from the reference design, where each service category owns a colour. It matters more here than it does
 * there: a provider's feed is a stack of jobs and a customer's home screen is a grid of trades, so colour lets
 * someone find "the electrician one" before they have read a single word. Because it carries meaning, the map is
 * exhaustive and fixed — every service has exactly one tint, and there are no spare tints to decorate with.
 *
 * `tint` is the fill, `ink` the text that sits on it (all pass AA on their own fill), and `dot` the saturated
 * version for a small marker where a full fill would shout.
 */
import type { Service } from "./taxonomy";

export type Tint = { tint: string; ink: string; dot: string };

export const SERVICE_TINT: Record<Service, Tint> = {
  plumber:          { tint: "#CFE4F8", ink: "#1B3A55", dot: "#3E7FB8" },
  electrician:      { tint: "#F8F0C2", ink: "#4A3D0E", dot: "#B79514" },
  carpenter:        { tint: "#FBDDC3", ink: "#4E3116", dot: "#BD7434" },
  ac_technician:    { tint: "#D8EDC6", ink: "#2A4318", dot: "#5C9138" },
  appliance_repair: { tint: "#DFD7F7", ink: "#33255E", dot: "#6D57C4" },
  painter:          { tint: "#FAD1E6", ink: "#54203C", dot: "#C0518D" },
  cleaner:          { tint: "#D7E9DE", ink: "#1F4033", dot: "#47876C" },
  mechanic:         { tint: "#FBD4CC", ink: "#55251C", dot: "#C05A45" },
};

const FALLBACK: Tint = { tint: "#EDE9FD", ink: "#33255E", dot: "#6D57C4" };

/** Never throws: an unknown or legacy skill (doctor, swimmer…) gets the neutral tint rather than breaking a screen. */
export const tintOf = (service: string | null | undefined): Tint =>
  (service && SERVICE_TINT[service as Service]) || FALLBACK;
