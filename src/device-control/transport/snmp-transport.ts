import * as snmp from 'net-snmp';
import { SnmpSetOp } from '../adapters/vendor-adapter.interface';

export interface SnmpTargetOptions {
  host: string;
  port?: number;
  /** v1/v2c */
  community?: string;
  version?: 'v1' | 'v2c' | 'v3';
  timeoutMs?: number;
  /** v3 only */
  v3?: {
    userName: string;
    authProtocol?: 'sha' | 'md5';
    authKey?: string;
    privProtocol?: 'aes' | 'des';
    privKey?: string;
  };
}

const TYPE_MAP: Record<SnmpSetOp['type'], number> = {
  Integer: snmp.ObjectType.Integer,
  OctetString: snmp.ObjectType.OctetString,
  IpAddress: snmp.ObjectType.IpAddress,
  RowStatus: snmp.ObjectType.Integer, // RowStatus is INTEGER-valued (RFC 2579 enum) on the wire
  Unsigned32: snmp.ObjectType.Unsigned32,
  Counter64: snmp.ObjectType.Counter64,
};

function openSession(opts: SnmpTargetOptions): snmp.Session {
  const version = opts.version === 'v3' ? snmp.Version3 : opts.version === 'v1' ? snmp.Version1 : snmp.Version2c;
  const sessionOptions = { port: opts.port ?? 161, timeout: opts.timeoutMs ?? 5000, version };

  if (opts.version === 'v3') {
    if (!opts.v3) throw new Error('SNMPv3 target requires v3 user options');
    return snmp.createV3Session(opts.host, opts.v3.userName, {
      ...sessionOptions,
      level: opts.v3.privKey
        ? snmp.SecurityLevel.authPriv
        : opts.v3.authKey
          ? snmp.SecurityLevel.authNoPriv
          : snmp.SecurityLevel.noAuthNoPriv,
      authProtocol: opts.v3.authProtocol === 'md5' ? snmp.AuthProtocols.md5 : snmp.AuthProtocols.sha,
      authKey: opts.v3.authKey,
      privProtocol: opts.v3.privProtocol === 'des' ? snmp.PrivProtocols.des : snmp.PrivProtocols.aes,
      privKey: opts.v3.privKey,
    });
  }
  return snmp.createSession(opts.host, opts.community ?? 'public', sessionOptions);
}

/** SNMPv2-MIB::sysUpTime.0 — the standard baseline reachability probe (see standard-mibs.md: "always poll first"). */
const SYS_UP_TIME_OID = '1.3.6.1.2.1.1.3.0';

export async function snmpProbeReachable(opts: SnmpTargetOptions): Promise<boolean> {
  try {
    await snmpGet(opts, [SYS_UP_TIME_OID]);
    return true;
  } catch {
    return false;
  }
}

export function snmpGet(opts: SnmpTargetOptions, oids: string[]): Promise<snmp.VarbindType[]> {
  return new Promise((resolve, reject) => {
    const session = openSession(opts);
    session.get(oids, (err: Error | null, varbinds: snmp.VarbindType[]) => {
      session.close();
      if (err) return reject(err);
      for (const vb of varbinds) {
        if (snmp.isVarbindError(vb)) return reject(new Error(snmp.varbindError(vb)));
      }
      resolve(varbinds);
    });
  });
}

export function snmpWalk(opts: SnmpTargetOptions, baseOid: string): Promise<snmp.VarbindType[]> {
  return new Promise((resolve, reject) => {
    const session = openSession(opts);
    const results: snmp.VarbindType[] = [];
    session.walk(
      baseOid,
      (varbinds: snmp.VarbindType[]) => {
        for (const vb of varbinds) if (!snmp.isVarbindError(vb)) results.push(vb);
      },
      (err: Error | null) => {
        session.close();
        if (err) return reject(err);
        resolve(results);
      },
    );
  });
}

/**
 * Applies a vendor adapter's buildSnmpPlan() output as literal SNMP SETs.
 * Only ever called after capability-registry.service.ts confirms a
 * documented write path exists for this vendor+action — this function does
 * not itself decide whether the SET should be attempted.
 */
export function snmpSet(opts: SnmpTargetOptions, ops: SnmpSetOp[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const session = openSession(opts);
    const varbinds = ops.map((op) => ({
      oid: op.oid,
      type: TYPE_MAP[op.type],
      value: op.type === 'OctetString' ? Buffer.from(String(op.value), 'utf8') : op.value,
    }));
    session.set(varbinds, (err: Error | null, response: snmp.VarbindType[]) => {
      session.close();
      if (err) return reject(err);
      for (const vb of response) {
        if (snmp.isVarbindError(vb)) return reject(new Error(snmp.varbindError(vb)));
      }
      resolve();
    });
  });
}
