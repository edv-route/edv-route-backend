/** JSON Schemas of the identity endpoints (serialization is strict: undeclared fields are dropped). */

const nullableDate = { type: ['string', 'null'], format: 'date-time' } as const;

export const identityViewSchema = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['missing', 'rejected', 'pending', 'approved'] },
    required: { type: 'boolean' },
    photos: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          kind: { type: 'string', enum: ['selfie', 'id_front', 'id_back'] },
          status: { type: 'string', enum: ['pending', 'approved', 'rejected'] },
          rejectionReason: { type: ['string', 'null'] },
          uploadedAt: { type: 'string', format: 'date-time' },
          reviewedAt: nullableDate,
          reviewedByName: { type: ['string', 'null'] },
          url: { type: ['string', 'null'] },
        },
      },
    },
  },
} as const;

export const kindParamSchema = {
  type: 'object',
  required: ['kind'],
  properties: { kind: { type: 'string', enum: ['selfie', 'id_front', 'id_back'] } },
} as const;

export const photoIdParamSchema = {
  type: 'object',
  required: ['photoId'],
  properties: { photoId: { type: 'string', format: 'uuid' } },
} as const;

export const userIdParamSchema = {
  type: 'object',
  required: ['userId'],
  properties: { userId: { type: 'string', format: 'uuid' } },
} as const;

export const rejectBodySchema = {
  type: 'object',
  required: ['reason'],
  additionalProperties: false,
  properties: { reason: { type: 'string', minLength: 1, maxLength: 500 } },
} as const;

/** The value `/me` carries so the app knows which screen to open. */
export const identityStatusProperty = {
  type: 'string',
  enum: ['missing', 'rejected', 'pending', 'approved'],
} as const;
