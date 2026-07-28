import { Injectable } from '@nestjs/common';
import { VendorAdapter } from './vendor-adapter.interface';
import { CiscoIosAdapter } from './cisco-ios.adapter';
import { JuniperJunosAdapter } from './juniper-junos.adapter';
import { AristaEosAdapter } from './arista-eos.adapter';
import { MikrotikRouterosAdapter } from './mikrotik-routeros.adapter';
import { ExtremeExosAdapter } from './extreme-exos.adapter';
import { HuaweiVrpAdapter } from './huawei-vrp.adapter';
import { ArubaAosCxAdapter } from './aruba-aoscx.adapter';
import { DellOs10Adapter } from './dell-os10.adapter';
import { DlinkAdapter } from './dlink.adapter';
import { FortinetAdapter } from './fortinet.adapter';
import { UbiquitiAdapter } from './ubiquiti.adapter';
import { NetgearAdapter } from './netgear.adapter';
import { ZyxelAdapter } from './zyxel.adapter';
import { GenericSnmpAdapter } from './generic-snmp.adapter';

/**
 * Resolves a devices.vendor_profile_id to a concrete VendorAdapter.
 * New vendors register themselves here — this is the one place that needs
 * a one-line addition when a new vendor adapter ships. All 13 documented
 * vendors now have an adapter; any future vendor not yet implemented falls
 * back to GenericSnmpAdapter.
 */
@Injectable()
export class AdapterRegistryService {
  private readonly adapters = new Map<string, VendorAdapter>();
  private readonly fallback = new GenericSnmpAdapter();

  constructor() {
    this.register(new CiscoIosAdapter());
    this.register(new JuniperJunosAdapter());
    this.register(new AristaEosAdapter());
    this.register(new MikrotikRouterosAdapter());
    this.register(new ExtremeExosAdapter());
    this.register(new HuaweiVrpAdapter());
    this.register(new ArubaAosCxAdapter());
    this.register(new DellOs10Adapter());
    this.register(new DlinkAdapter());
    this.register(new FortinetAdapter());
    this.register(new UbiquitiAdapter());
    this.register(new NetgearAdapter());
    this.register(new ZyxelAdapter());
  }

  register(adapter: VendorAdapter): void {
    this.adapters.set(adapter.profileId, adapter);
  }

  resolve(vendorProfileId: string | null | undefined): VendorAdapter {
    if (!vendorProfileId) return this.fallback;
    return this.adapters.get(vendorProfileId) ?? this.fallback;
  }

  list(): string[] {
    return [...this.adapters.keys()];
  }
}
