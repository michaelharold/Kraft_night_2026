/**
 * Is the requester the person in trouble ("self") or a witness ("other")? Keyword heuristic only; the requester
 * can flip it in the UI. Anyone else mentioned wins ("I'm with my father who collapsed" → other).
 */
import type { RequesterRole } from "./types";

const OTHER = /\b(my (father|dad|mother|mom|mum|amma|achan|grand\w*|son|daughter|wife|husband|friend|brother|sister|baby|child|kid|uncle|aunt|neighbou?r|colleague|roommate)|someone|somebody|a (man|woman|boy|girl|child|person|kid|guy)|he|she|his|her|they|people|person|patient|family)\b/i;
const SELF = /\b(i|i'm|im|i am|i've|ive|me|my|myself|mine)\b/i;

export function inferRole(text: string): RequesterRole {
  if (OTHER.test(text)) return "other";
  return SELF.test(text) ? "self" : "other";
}
