import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';

const USER_UNIT = fileURLToPath(new URL('../../etc/systemd/fpdf.service', import.meta.url));

/**
 * What the server needs: sockets for HTTP (AF_INET*), the C library's and `ss`'s interface and socket
 * listing (AF_NETLINK) and local IPC (AF_UNIX). Raw packet sockets are not used.
 */
const REQUIRED_ADDRESS_FAMILIES = ['AF_INET', 'AF_INET6', 'AF_NETLINK', 'AF_UNIX'];

/**
 * Every `[Service]` assignment of a unit file, in order, per key. A trailing backslash joins the next
 * line, comment and blank lines inside a continued value are skipped, and repeats are kept because
 * systemd accumulates some keys (`RestrictAddressFamilies`) instead of letting the last one win.
 */
function assignments(text: string): Map<string, string[]> {
  const joined: string[] = [];
  let pending = '';
  for (const raw of text.split('\n')) {
    const stripped = raw.trim();
    if (
      pending !== '' &&
      (stripped === '' || stripped.startsWith('#') || stripped.startsWith(';'))
    ) {
      continue;
    }
    const line = pending + stripped;
    if (line.endsWith('\\')) {
      pending = `${line.slice(0, -1).trimEnd()} `;
      continue;
    }
    pending = '';
    joined.push(line);
  }
  const result = new Map<string, string[]>();
  let inService = false;
  for (const line of joined) {
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;
    const header = /^\[(\w+)\]$/.exec(line);
    if (header) {
      inService = header[1] === 'Service';
      continue;
    }
    const eq = line.indexOf('=');
    if (inService && eq > 0) {
      const key = line.slice(0, eq).trim();
      result.set(key, [...(result.get(key) ?? []), line.slice(eq + 1).trim()]);
    }
  }
  return result;
}

function single(text: string, key: string): string {
  const values = assignments(text).get(key) ?? [];
  if (values.length !== 1) {
    throw new Error(`Expected exactly one ${key}= assignment, got ${JSON.stringify(values)}`);
  }
  return values[0] ?? '';
}

describe('the shipped systemd user unit (baseline hardening)', () => {
  let unit = '';

  beforeEach(async () => {
    unit = await readFile(USER_UNIT, 'utf-8');
  });

  it('forbids gaining privileges', () => {
    expect(single(unit, 'NoNewPrivileges')).toBe('true');
  });

  it('mounts the system directories read-only', () => {
    expect(single(unit, 'ProtectSystem')).toBe('full');
  });

  it('restricts the address families to what the server uses', () => {
    const families = single(unit, 'RestrictAddressFamilies').split(/\s+/).sort();
    expect(families).toEqual(REQUIRED_ADDRESS_FAMILIES);
  });

  it('pins the system call architecture so the address-family filter holds', () => {
    // On a host that also runs 32-bit x86 code RestrictAddressFamilies does not cover those calls (and systemd
    // ignores it on a few other ABIs), so systemd recommends pairing it with SystemCallArchitectures=native.
    expect(single(unit, 'SystemCallArchitectures')).toBe('native');
  });

  it('leaves the home directory writable, /tmp shared and the syscalls unfiltered', () => {
    // The server browses the home directory and saves next to the source PDF wherever the user chose, which can
    // be /tmp, and a syscall filter can break a service at runtime.
    const keys = assignments(unit);
    expect(keys.has('ProtectHome')).toBe(false);
    expect(keys.has('PrivateTmp')).toBe(false);
    expect(keys.has('SystemCallFilter')).toBe(false);
    expect(keys.get('ProtectSystem')).not.toEqual(['strict']);
  });
});

describe('the unit file parser', () => {
  it('ignores other sections and comments', () => {
    const text = '[Unit]\nNoNewPrivileges=false\n[Service]\n# PrivateTmp=false\nPrivateTmp=true\n';
    expect([...assignments(text)]).toEqual([['PrivateTmp', ['true']]]);
  });

  it('joins continued lines, skips comments inside them and keeps repeated keys', () => {
    const text = [
      '[Service]',
      'RestrictAddressFamilies=AF_INET \\',
      '# a comment between the lines',
      '  AF_UNIX',
      'RestrictAddressFamilies=AF_PACKET',
      '',
    ].join('\n');
    expect(assignments(text).get('RestrictAddressFamilies')).toEqual([
      'AF_INET AF_UNIX',
      'AF_PACKET',
    ]);
  });

  it('rejects a repeated pinned directive', () => {
    const text = '[Service]\nRestrictAddressFamilies=AF_INET\nRestrictAddressFamilies=AF_PACKET\n';
    expect(() => single(text, 'RestrictAddressFamilies')).toThrow('Expected exactly one');
  });
});
