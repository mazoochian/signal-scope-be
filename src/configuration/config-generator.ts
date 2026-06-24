// Generates vendor-realistic running configurations for simulated devices.

interface DeviceInfo {
  id: number;
  name: string;
  ip: string;
  vendor: string;
  model: string;
  role: string;
}

interface InterfaceInfo {
  name: string;
  description: string;
  speed: string;
  vlan: string | null;
  status: string;
  duplex: string;
}

export function generateRunningConfig(device: DeviceInfo, interfaces: InterfaceInfo[]): string {
  const vendor = (device.vendor ?? '').toLowerCase();
  if (vendor.includes('cisco')) return ciscoConfig(device, interfaces);
  if (vendor.includes('juniper')) return juniperConfig(device, interfaces);
  if (vendor.includes('arista')) return aristaConfig(device, interfaces);
  if (vendor.includes('palo')) return panosConfig(device, interfaces);
  if (vendor.includes('nokia')) return nokiaConfig(device, interfaces);
  return genericConfig(device, interfaces);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function hostname(name: string): string { return name; }

function ts(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

function ciscoInterfaceBlock(iface: InterfaceInfo): string {
  const lines = [`interface ${iface.name}`, ` description ${iface.description || 'no description'}`];
  if (iface.vlan === 'trunk') {
    lines.push(' switchport mode trunk');
    lines.push(' switchport trunk encapsulation dot1q');
    lines.push(' spanning-tree portfast trunk');
  } else if (iface.vlan === 'wan-100') {
    lines.push(' no switchport');
    lines.push(' ip address dhcp');
    lines.push(' ip nat outside');
  } else if (iface.vlan) {
    lines.push(` switchport access vlan ${iface.vlan}`);
    lines.push(' switchport mode access');
    lines.push(' spanning-tree portfast');
  } else {
    lines.push(' switchport mode access');
  }
  if (iface.status === 'down') lines.push(' shutdown');
  else lines.push(' no shutdown');
  if (iface.speed === '10G') lines.push(' speed 10000', ' duplex full');
  lines.push('!');
  return lines.join('\n');
}

// ── Cisco IOS-XE ─────────────────────────────────────────────────────────────

function ciscoConfig(d: DeviceInfo, ifaces: InterfaceInfo[]): string {
  const isRouter = d.role.includes('router');
  const isWLC = d.role === 'wlc';
  return `! Last configuration change at ${ts()} by admin
! NVRAM config last updated at ${ts()} by admin
version 17.12
service timestamps debug datetime msec
service timestamps log datetime msec
service password-encryption
!
hostname ${hostname(d.name)}
!
boot-start-marker
boot-end-marker
!
no aaa new-model
!
clock timezone UTC 0 0
!
ip routing
ip domain name corp.example.com
ip name-server 8.8.8.8 8.8.4.4
no ip http server
ip http secure-server
ip http authentication local
!
${isRouter ? `
ip bgp-community new-format
!
router bgp 65000
 bgp log-neighbor-changes
 neighbor 10.0.0.5 remote-as 65001
 neighbor 10.0.0.5 timers 10 30
 neighbor 10.0.0.5 description ISP-A-EBGP
 !
 address-family ipv4
  neighbor 10.0.0.5 activate
  neighbor 10.0.0.5 soft-reconfiguration inbound
  redistribute connected route-map RM-CONNECTED
 exit-address-family
!
ip prefix-list PL-DEFAULT seq 10 permit 0.0.0.0/0
ip prefix-list PL-RFC1918 seq 10 permit 10.0.0.0/8 le 32
ip prefix-list PL-RFC1918 seq 20 permit 172.16.0.0/12 le 32
ip prefix-list PL-RFC1918 seq 30 permit 192.168.0.0/16 le 32
!
route-map RM-CONNECTED permit 10
 match ip address prefix-list PL-RFC1918
!` : ''}
${isWLC ? `
wireless management interface Vlan50
wireless rf-network CORP-RF
 dca sensitivity medium
 dca update-interval-min 10
!
ap dot11 24ghz rx-sop threshold low
ap dot11 5ghz rx-sop threshold medium
!
wlan CORP-WIFI 1 CORP-SSID
 client vlan 50
 no security wpa akm dot1x
 security wpa psk set-key ascii 0 ChangeMe2024!
 no shutdown
 radio policy dot11 24ghz
 radio policy dot11 5ghz
!` : ''}
${ifaces.map(ciscoInterfaceBlock).join('\n')}
!
ip access-list extended ACL-MGMT
 10 permit ip 10.0.99.0 0.0.0.255 any
 20 deny   ip any any log
!
ntp server 216.239.35.0
ntp server 216.239.35.4
!
line con 0
 exec-timeout 10 0
 logging synchronous
line vty 0 15
 access-class ACL-MGMT in
 exec-timeout 30 0
 login local
 transport input ssh
!
crypto key generate rsa modulus 4096
ip ssh version 2
ip ssh time-out 60
ip ssh authentication-retries 3
!
snmp-server community public RO
snmp-server community private RW
snmp-server location ${d.name} · ${d.ip}
snmp-server contact noc@example.com
!
logging host 10.0.99.10
logging buffered 16384 notifications
!
end
`;
}

// ── Juniper JunOS ────────────────────────────────────────────────────────────

function juniperConfig(d: DeviceInfo, ifaces: InterfaceInfo[]): string {
  const ifBlocks = ifaces.map((i) => `
    ${i.name.toLowerCase().replace('te', 'et-0/0/').replace('gi', 'ge-0/0/')} {
        description "${i.description}";
        speed ${i.speed === '10G' ? '10g' : '1g'};
        link-mode full-duplex;
        ${i.vlan === 'trunk'
          ? 'unit 0 {\n            family ethernet-switching {\n                interface-mode trunk;\n            }\n        }'
          : i.vlan
          ? `unit 0 {\n            family ethernet-switching {\n                interface-mode access;\n                vlan { members ${i.vlan}; }\n            }\n        }`
          : 'unit 0 { family inet { address dhcp; } }'
        }
        ${i.status === 'down' ? 'disable;' : ''}
    }`.trim()).join('\n    ');

  return `## Last changed: ${ts()}
## Image: junos-21.4R3.15-signed.tgz
##

system {
    host-name ${d.name};
    domain-name corp.example.com;
    time-zone UTC;
    root-authentication {
        encrypted-password "$6$...REDACTED...";
    }
    name-server {
        8.8.8.8;
        8.8.4.4;
    }
    syslog {
        host 10.0.99.10 {
            any notice;
            authorization info;
        }
        file messages {
            any notice;
            authorization info;
        }
    }
    ntp {
        server 216.239.35.0;
        server 216.239.35.4;
    }
    services {
        ssh {
            root-login deny;
            protocol-version v2;
        }
        netconf {
            ssh;
        }
    }
}

chassis {
    alarm {
        management-ethernet {
            link-down ignore;
        }
    }
}

interfaces {
    ${ifBlocks}
    lo0 {
        unit 0 {
            family inet {
                address ${d.ip}/32 { primary; }
            }
        }
    }
}

protocols {
    bgp {
        group EBGP-ISP {
            type external;
            peer-as 65001;
            local-as 65000;
            neighbor 10.0.0.5 {
                description "ISP-A upstream";
                authentication-key "$9$...REDACTED...";
            }
        }
        group IBGP-CORE {
            type internal;
            local-address ${d.ip};
            export [ EXPORT-IBGP ];
        }
    }
    ospf {
        area 0.0.0.0 {
            interface lo0.0 { passive; }
        }
    }
    lldp { interface all; }
    rstp { interface all; }
}

policy-options {
    prefix-list RFC1918 {
        10.0.0.0/8;
        172.16.0.0/12;
        192.168.0.0/16;
    }
    policy-statement EXPORT-IBGP {
        term ACCEPT-DIRECT {
            from protocol direct;
            then accept;
        }
        term REJECT-REST {
            then reject;
        }
    }
}

snmp {
    location "${d.name} · ${d.ip}";
    contact "noc@example.com";
    community public {
        authorization read-only;
    }
    trap-group NOC {
        targets { 10.0.99.10; }
        categories { link; }
    }
}
`;
}

// ── Arista EOS ───────────────────────────────────────────────────────────────

function aristaConfig(d: DeviceInfo, ifaces: InterfaceInfo[]): string {
  return `! device: ${d.name} (${d.model}, EOS-4.32.0F)
! last modified: ${ts()}
!
transceiver qsfp default-mode 4x10G
!
service routing protocols model ribd
!
hostname ${d.name}
!
dns domain corp.example.com
!
spanning-tree mode mstp
spanning-tree mst 0 priority 4096
!
aaa authentication login default local
aaa authorization exec default local
!
username admin privilege 15 role network-admin secret sha512 $6$...REDACTED...
username noc privilege 5 role network-operator secret sha512 $6$...REDACTED...
!
${ifaces.map((i) => {
  const lines = [`interface ${i.name}`, `   description ${i.description}`];
  if (i.vlan === 'trunk') {
    lines.push('   switchport mode trunk', '   switchport trunk allowed vlan all');
  } else if (i.vlan) {
    lines.push(`   switchport access vlan ${i.vlan}`, '   switchport mode access');
  } else {
    lines.push('   no switchport');
  }
  if (i.status === 'down') lines.push('   shutdown');
  lines.push('!');
  return lines.join('\n');
}).join('\n')}
!
ip routing
!
router ospf 1
   router-id ${d.ip}
   network 10.0.0.0/8 area 0.0.0.0
   max-lsa 12000
!
router bgp 65000
   bgp asn 65000
   router-id ${d.ip}
   bgp log-neighbor-changes
   neighbor IBGP-PEERS peer group
   neighbor IBGP-PEERS update-source Loopback0
   neighbor IBGP-PEERS send-community
   !
   address-family ipv4
      neighbor IBGP-PEERS activate
!
ip route 0.0.0.0/0 10.0.0.1
!
management api http-commands
   protocol https
   no shutdown
   !
   vrf default
      no shutdown
!
management api gnmi
   transport grpc default
!
snmp-server community public ro
snmp-server host 10.0.99.10 traps version 2c public
snmp-server location ${d.name} ${d.ip}
!
ntp server 216.239.35.0 prefer
ntp server 216.239.35.4
!
logging host 10.0.99.10 514
logging format timestamp traditional
!
ip access-list MGMT-ACL
   10 permit ip 10.0.99.0/24 any
   20 deny ip any any
!
management ssh
   idle-timeout 30
   authentication mode password
   access-group MGMT-ACL
!
end
`;
}

// ── Palo Alto PAN-OS ─────────────────────────────────────────────────────────

function panosConfig(d: DeviceInfo, ifaces: InterfaceInfo[]): string {
  return `# PAN-OS ${d.model} Running Configuration
# Generated: ${ts()}
# Device: ${d.name} (${d.ip})
# Serial: PA-XXXXXX-SIMULATED

set deviceconfig system hostname ${d.name}
set deviceconfig system domain corp.example.com
set deviceconfig system dns-setting servers primary 8.8.8.8
set deviceconfig system dns-setting servers secondary 8.8.4.4
set deviceconfig system ntp-servers primary-ntp-server ntp-server-address 216.239.35.0
set deviceconfig system ntp-servers secondary-ntp-server ntp-server-address 216.239.35.4
set deviceconfig system ip-address ${d.ip}
set deviceconfig system netmask 255.255.255.0
set deviceconfig system default-gateway 10.2.0.254
set deviceconfig system login-banner "AUTHORIZED ACCESS ONLY — MONITORING SYSTEM"

# Zones
set zone UNTRUST network layer3 ${ifaces.filter(i => i.vlan === 'wan-100').map(i => i.name).join(' ') || 'ethernet1/1'}
set zone TRUST network layer3 ${ifaces.filter(i => i.status === 'up' && i.vlan !== 'wan-100').map(i => i.name).join(' ') || 'ethernet1/2 ethernet1/3'}
set zone MGMT network layer3 management

# Interfaces
${ifaces.map((i) => `set network interface ethernet ${i.name.toLowerCase()} layer3 ip ${d.ip}/24
set network interface ethernet ${i.name.toLowerCase()} comment "${i.description}"`).join('\n')}

# Security Rules
set rulebase security rules ALLOW-OUTBOUND from TRUST
set rulebase security rules ALLOW-OUTBOUND to UNTRUST
set rulebase security rules ALLOW-OUTBOUND application any
set rulebase security rules ALLOW-OUTBOUND service application-default
set rulebase security rules ALLOW-OUTBOUND action allow
set rulebase security rules ALLOW-OUTBOUND profile-setting group OUTBOUND-PROFILE

set rulebase security rules BLOCK-ALL from any
set rulebase security rules BLOCK-ALL to any
set rulebase security rules BLOCK-ALL application any
set rulebase security rules BLOCK-ALL service any
set rulebase security rules BLOCK-ALL action deny
set rulebase security rules BLOCK-ALL log-start yes

# NAT Rules
set rulebase nat rules OUTBOUND-NAT source-translation dynamic-ip-and-port interface-address interface ethernet1/1
set rulebase nat rules OUTBOUND-NAT from TRUST
set rulebase nat rules OUTBOUND-NAT to UNTRUST
set rulebase nat rules OUTBOUND-NAT source any
set rulebase nat rules OUTBOUND-NAT destination any

# Threat Prevention
set profiles virus DEFAULT action reset-both
set profiles spyware DEFAULT botnet-domains action sinkhole
set profiles vulnerability DEFAULT rules ALL action reset-both severity any

# Log Settings
set log-settings syslog NOC-SYSLOG server NOC address 10.0.99.10
set log-settings syslog NOC-SYSLOG server NOC transport UDP
set log-settings syslog NOC-SYSLOG server NOC port 514
set log-settings syslog NOC-SYSLOG server NOC facility LOG_USER
set log-settings syslog NOC-SYSLOG server NOC format IETF

# Commit
`;
}

// ── Nokia SR OS ──────────────────────────────────────────────────────────────

function nokiaConfig(d: DeviceInfo, ifaces: InterfaceInfo[]): string {
  return `# TiMOS-B-23.7.R2 both/x86_64 Nokia 7750 SR Copyright (c) 2000-2026 Nokia.
# Configuration last modified: ${ts()}

configure {
    system {
        name "${d.name}"
        dns {
            domain "corp.example.com"
            servers {
                address "8.8.8.8" "8.8.4.4"
            }
        }
        time {
            zone { utc true }
            ntp {
                server "216.239.35.0" prefer true
                server "216.239.35.4"
            }
        }
        snmp {
            community "public" access read-only
            trap-target "10.0.99.10:162" version snmpv2c notify-community "public"
        }
        security {
            ssh {
                server-cipher-list-v2 {
                    cipher 190 name aes256-gcm@openssh.com
                    cipher 200 name aes128-gcm@openssh.com
                }
            }
            user "admin" {
                access { console true netconf true }
                console { member ["administrative"] }
                password hash2 "$2y$10$...REDACTED..."
            }
        }
        syslog {
            target "NOC" {
                address "10.0.99.10"
                severity info
                log-events
            }
        }
    }

    port {
${ifaces.map((i, idx) => `        ${idx + 1}/1/${idx + 1} {
            description "${i.description}"
            admin-state ${i.status === 'down' ? 'disable' : 'enable'}
            ethernet {
                mode ${i.vlan === 'trunk' ? 'hybrid' : 'access'}
                speed ${i.speed === '10G' ? 'auto' : '1000'}
            }
        }`).join('\n')}
    }

    router "Base" {
        router-id ${d.ip}
        autonomous-system 65000
        ospf 0 {
            area "0.0.0.0" {
                interface "system" { passive true }
                interface "to-core" { interface-type point-to-point }
            }
        }
        bgp {
            group "EBGP-UPSTREAM" {
                type external
                peer-as 65001
                neighbor "10.0.0.5" {
                    description "ISP-A upstream"
                    authentication-key hash2 "$2y$10$...REDACTED..."
                }
            }
            group "IBGP-CORE" {
                type internal
                local-as 65000
            }
        }
        mpls {
            admin-state enable
            interface "to-core" { admin-state enable }
        }
        ldp {
            admin-state enable
            interface "to-core" { admin-state enable }
        }
    }

    service {
        vprn 100 name "CORP-L3VPN" {
            admin-state enable
            route-distinguisher "65000:100"
            interface "lo-100" {
                loopback true
                ipv4 { primary { address ${d.ip} prefix-length 32 } }
            }
        }
    }

    log {
        log-id "99" {
            source { main true change true }
            destination {
                syslog "NOC"
            }
        }
    }
}
`;
}

// ── Generic fallback ─────────────────────────────────────────────────────────

function genericConfig(d: DeviceInfo, ifaces: InterfaceInfo[]): string {
  return `# Running Configuration
# Device: ${d.name} (${d.vendor} ${d.model})
# IP: ${d.ip}
# Generated: ${ts()}

hostname ${d.name}
interfaces:
${ifaces.map((i) => `  ${i.name}: ${i.description} [${i.status}] vlan=${i.vlan ?? 'none'}`).join('\n')}
`;
}
