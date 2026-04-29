import bcrypt from "bcryptjs";
import { randomBytes } from "crypto";

// 32-char alphabet — uppercase + digits, minus 0/1/I/O/l for receipt legibility.
const PIN_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const PIN_LENGTH = 8;
const BCRYPT_COST = 12;

export function generatePin(): string {
  const bytes = randomBytes(PIN_LENGTH);
  let pin = "";
  for (let i = 0; i < PIN_LENGTH; i++) {
    pin += PIN_ALPHABET[bytes[i] % PIN_ALPHABET.length];
  }
  return pin;
}

export async function hashPin(pin: string): Promise<string> {
  return bcrypt.hash(pin, BCRYPT_COST);
}

export async function verifyPin(pin: string, hash: string): Promise<boolean> {
  return bcrypt.compare(pin, hash);
}
