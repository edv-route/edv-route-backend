const benefitSchema = {
  type: 'object',
  properties: {
    id: { type: 'integer' },
    name: { type: 'string' },
    description: { type: ['string', 'null'] },
    active: { type: 'boolean' },
    createdAt: { type: 'string' },
    updatedAt: { type: 'string' },
  },
} as const;

const idParam = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'integer', minimum: 1 } },
} as const;

export const listBenefitsSchema = {
  response: { 200: { type: 'array', items: benefitSchema } },
} as const;

export const createBenefitSchema = {
  body: {
    type: 'object',
    required: ['name'],
    additionalProperties: false,
    properties: {
      name: { type: 'string', minLength: 3, maxLength: 120 },
      description: { type: ['string', 'null'], maxLength: 1000 },
    },
  },
  response: { 201: benefitSchema },
} as const;

export const updateBenefitSchema = {
  params: idParam,
  body: {
    type: 'object',
    additionalProperties: false,
    minProperties: 1,
    properties: {
      name: { type: 'string', minLength: 3, maxLength: 120 },
      description: { type: ['string', 'null'], maxLength: 1000 },
      active: { type: 'boolean' },
    },
  },
  response: { 200: benefitSchema },
} as const;

export const deleteBenefitSchema = {
  params: idParam,
  response: { 204: { type: 'null' } },
} as const;
