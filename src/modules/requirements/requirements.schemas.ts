const requirementSchema = {
  type: 'object',
  properties: {
    id: { type: 'integer' },
    name: { type: 'string' },
    description: { type: ['string', 'null'] },
    appliesTo: { type: 'string', enum: ['driver', 'vehicle'] },
    isRequired: { type: 'boolean' },
    active: { type: 'boolean' },
    createdBy: { type: ['string', 'null'] },
    createdAt: { type: 'string' },
    updatedAt: { type: 'string' },
  },
} as const;

const idParam = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'integer', minimum: 1 } },
} as const;

export const listRequirementsSchema = {
  response: { 200: { type: 'array', items: requirementSchema } },
} as const;

export const createRequirementSchema = {
  body: {
    type: 'object',
    required: ['name', 'appliesTo'],
    additionalProperties: false,
    properties: {
      name: { type: 'string', minLength: 3, maxLength: 120 },
      description: { type: ['string', 'null'], maxLength: 1000 },
      appliesTo: { type: 'string', enum: ['driver', 'vehicle'] },
      isRequired: { type: 'boolean', default: false },
    },
  },
  response: { 201: requirementSchema },
} as const;

export const updateRequirementSchema = {
  params: idParam,
  body: {
    type: 'object',
    additionalProperties: false,
    minProperties: 1,
    properties: {
      name: { type: 'string', minLength: 3, maxLength: 120 },
      description: { type: ['string', 'null'], maxLength: 1000 },
      appliesTo: { type: 'string', enum: ['driver', 'vehicle'] },
      isRequired: { type: 'boolean' },
      active: { type: 'boolean' },
    },
  },
  response: { 200: requirementSchema },
} as const;

export const deleteRequirementSchema = {
  params: idParam,
  response: { 204: { type: 'null' } },
} as const;
