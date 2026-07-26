import { Injectable } from '@nestjs/common';
import { VendorAdapter } from './vendor-adapter.interface';
import { CiscoIosAdapter } from './cisco-ios.adapter';
import { JuniperJunosAdapter } from './juniper-junos.adapter';
import { AristaEosAdapter } from './arista-eos.adapter';
import { MikrotikRouterosAdapter } from './mikrotik-routeros.adapter';
import { GenericSnmpAdapter } from './generic-snmp.adapter';

/**
 * Resolves a devices.vendor_profile_id to a concrete VendorAdapter.
 * New vendors register themselves here — this is the one place that needs
 * a one-line addition when a new vendor adapter ships (Juniper/Arista/
 * MikroTik add themselves here too; see the other adapters/*.adapter.ts
 * files added by the vendor subagents).
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
