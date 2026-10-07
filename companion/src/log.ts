// A line log in the companion home. Never stdout: in host mode stdout carries only framed messages.
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export type Log = (message: string) => void;

export function fileLog(home: string, role: string): Log {
  return (message) => {
    try {
      mkdirSync(home, { recursive: true });
      appendFileSync(join(home, 'companion.log'), `${new Date().toISOString()} ${role}[${process.pid}] ${message}\n`);
    } catch {
      // Logging must never take the host down.
    }
  };
}
