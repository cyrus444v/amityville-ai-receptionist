import { config } from '../config';
import type { Service } from '../types';

// The catalogue is the clinic's, not the build's: it arrives with the tenant
// configuration rather than being bundled at compile time, so a clinic can
// change what it offers without a rebuild.
const services: readonly Service[] = config.services;

export function searchServices(query: string): Service[] {
  const q = query.toLowerCase().trim();

  const genericPhrases = [
    'what services', 'what do you offer', 'what treatments', 'what can you',
    'services', 'treatments', 'all services',
  ];
  if (genericPhrases.some((p) => q.includes(p))) return [...services];

  return services.filter(
    (s) =>
      s.name.toLowerCase().includes(q) ||
      s.category.toLowerCase().includes(q) ||
      s.short_description.toLowerCase().includes(q) ||
      s.keywords.some((k) => k.toLowerCase().includes(q) || q.includes(k.toLowerCase()))
  );
}

export function getAllServices(): Service[] {
  return [...services];
}

export function getServiceByName(name: string): Service | undefined {
  const n = name.toLowerCase().trim();
  return services.find(
    (s) =>
      s.name.toLowerCase() === n ||
      n.startsWith(`${s.name.toLowerCase()} (`) ||
      s.service_id === n ||
      s.keywords.some((k) => k.toLowerCase() === n)
  );
}

export function getServiceDuration(service: Service): number {
  return service.duration_minutes ?? config.business.defaultDuration;
}

export function buildSpokenServiceList(results: Service[]): string {
  if (results.length === 0) return "I'm sorry, I couldn't find any matching services.";
  if (results.length === 1) return `We offer ${results[0].name}. ${results[0].short_description}`;

  const names = results.map((s) => s.name);
  const last = names.pop();
  return `We offer ${names.join(', ')}, and ${last}.`;
}
