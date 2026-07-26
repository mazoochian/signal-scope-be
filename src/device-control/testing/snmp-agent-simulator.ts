/**
 * Standalone SNMP agent simulator for testing snmp-transport.ts end-to-end
 * (real GET/SET/walk wire calls, not mocked) without needing a live device
 * or a pulled Docker image. Built with net-snmp's own createAgent/Mib
 * provider API (already a project dependency) rather than the third-party
 * `snmpsim` Docker image originally scoped for this — `docker pull` has no
 * network egress in this environment (confirmed: `docker pull node:20-alpine`
 * times out even though this shell's own `curl` reaches Docker Hub's HTTPS
 * endpoint fine, so it's specific to how the Docker daemon reaches the
 * registry here, not a general connectivity gap). This keeps the simulator
 * self-contained and runnable in CI without external pulls; a
 * docker-compose.sim.yml overlay is documented for a deployment
 * environment that does have registry egress — see device-control/README.md.
 *
 * Seeds exactly the OIDs the Cisco IOS adapter's buildSnmpPlan() targets:
 * IF-MIB::ifAdminStatus/ifOperStatus/ifDescr (ifTable), IF-MIB::ifName/ifAlias
 * (ifXTable), CISCO-VLAN-MEMBERSHIP-MIB::vmVlan/vmVlanType, plus the
 * standard SNMPv2-MIB::system group (sysUpTime is what the reachability
 * poller's snmpProbeReachable() checks).
 *
 * Run: npx ts-node src/device-control/testing/snmp-agent-simulator.ts [port] [community]
 */
import * as snmp from 'net-snmp';

const port = Number(process.argv[2] ?? 1161);
const community = process.argv[3] ?? 'public';

const agent = snmp.createAgent({ port, disableAuthorization: true }, (error) => {
  if (error) console.error('[snmp-sim] agent error:', error);
});
agent.getAuthorizer().addCommunity(community);

const mib = agent.getMib();

mib.registerProviders([
  {
    name: 'sysDescr',
    type: snmp.MibProviderType.Scalar,
    oid: '1.3.6.1.2.1.1.1',
    scalarType: snmp.ObjectType.OctetString,
    maxAccess: snmp.MaxAccess['read-only'],
  },
  {
    name: 'sysObjectID',
    type: snmp.MibProviderType.Scalar,
    oid: '1.3.6.1.2.1.1.2',
    scalarType: snmp.ObjectType.OID,
    maxAccess: snmp.MaxAccess['read-only'],
  },
  {
    name: 'sysUpTime',
    type: snmp.MibProviderType.Scalar,
    oid: '1.3.6.1.2.1.1.3',
    scalarType: snmp.ObjectType.TimeTicks,
    maxAccess: snmp.MaxAccess['read-only'],
  },
  {
    name: 'ifTable',
    type: snmp.MibProviderType.Table,
    oid: '1.3.6.1.2.1.2.2.1',
    tableIndex: [{ columnName: 'ifIndex' }],
    tableColumns: [
      { number: 1, name: 'ifIndex', type: snmp.ObjectType.Integer, maxAccess: snmp.MaxAccess['read-only'] },
      { number: 2, name: 'ifDescr', type: snmp.ObjectType.OctetString, maxAccess: snmp.MaxAccess['read-only'] },
      { number: 3, name: 'ifType', type: snmp.ObjectType.Integer, maxAccess: snmp.MaxAccess['read-only'] },
      { number: 7, name: 'ifAdminStatus', type: snmp.ObjectType.Integer, maxAccess: snmp.MaxAccess['read-write'] },
      { number: 8, name: 'ifOperStatus', type: snmp.ObjectType.Integer, maxAccess: snmp.MaxAccess['read-only'] },
    ],
  },
  {
    name: 'ifXTable',
    type: snmp.MibProviderType.Table,
    oid: '1.3.6.1.2.1.31.1.1.1',
    tableAugments: 'ifTable',
    tableColumns: [
      { number: 1, name: 'ifName', type: snmp.ObjectType.OctetString, maxAccess: snmp.MaxAccess['read-only'] },
      { number: 18, name: 'ifAlias', type: snmp.ObjectType.OctetString, maxAccess: snmp.MaxAccess['read-write'] },
    ],
  },
  {
    // CISCO-VLAN-MEMBERSHIP-MIB::vmMembershipTable, keyed by ifIndex —
    // see signal-scope-docs/vendors/cisco/mib-reference.md.
    name: 'vmMembershipTable',
    type: snmp.MibProviderType.Table,
    oid: '1.3.6.1.4.1.9.9.68.1.2.2.1',
    tableAugments: 'ifTable',
    tableColumns: [
      { number: 1, name: 'vmVlanType', type: snmp.ObjectType.Integer, maxAccess: snmp.MaxAccess['read-write'] },
      { number: 2, name: 'vmVlan', type: snmp.ObjectType.Integer, maxAccess: snmp.MaxAccess['read-write'] },
    ],
  },
]);

mib.setScalarValue('sysDescr', 'SignalScope SNMP simulator — Cisco IOS-XE fixture');
mib.setScalarValue('sysObjectID', '1.3.6.1.4.1.9.1.1745'); // arbitrary Catalyst-family sysObjectID under Cisco's PEN 9
// A scalar's ".0" instance node isn't created in the MIB tree until
// setScalarValue is called at least once (confirmed the hard way — a GET
// against an uninitialized scalar succeeds at the protocol level but
// returns a null value, not an error, which silently broke the
// reachability probe in early testing). A static value is fine here; this
// is a test fixture, not a real uptime counter.
mib.setScalarValue('sysUpTime', 12345);

// Seed two interfaces, matching the CLI stub server's fixture interface
// names. tableAugments tables still take the augmented table's index value
// as the leading row element(s), same as a foreign-indexed table.
mib.addTableRow('ifTable', [1, 'GigabitEthernet0/1', 6, 1, 1]); // ifIndex, ifDescr, ifType=ethernetCsmacd, adminUp, operUp
mib.addTableRow('ifXTable', [1, 'GigabitEthernet0/1', '']);
mib.addTableRow('vmMembershipTable', [1, 1, 1]); // vmVlanType=1 (static), vmVlan=1 (default VLAN)

mib.addTableRow('ifTable', [2, 'GigabitEthernet0/2', 6, 1, 1]);
mib.addTableRow('ifXTable', [2, 'GigabitEthernet0/2', '']);
mib.addTableRow('vmMembershipTable', [2, 1, 1]);

console.log(`[snmp-sim] Cisco fixture agent listening on 127.0.0.1:${port}, community "${community}"`);
