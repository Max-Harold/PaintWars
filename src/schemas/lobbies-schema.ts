import type { CollectionSchema } from 'deepspace/schema'

/** Small durable directory records; live movement and trail packets use PresenceRoom. */
export const lobbiesSchema: CollectionSchema = {
  name: 'lobbies',
  columns: [
    { name: 'code', storage: 'text', interpretation: 'plain', required: true },
    { name: 'visibility', storage: 'text', interpretation: 'plain', required: true },
    { name: 'maxPlayers', storage: 'number', interpretation: 'plain', required: true },
    { name: 'playerCount', storage: 'number', interpretation: 'plain', required: true },
    { name: 'status', storage: 'text', interpretation: 'plain', required: true },
  ],
  visibilityField: { field: 'visibility', value: 'public' },
  permissions: {
    '*': { read: 'published', create: true, update: 'own', delete: 'own' },
    viewer: { read: 'published', create: true, update: 'own', delete: 'own' },
    member: { read: 'published', create: true, update: 'own', delete: 'own' },
    admin: { read: true, create: true, update: true, delete: true },
  },
}
