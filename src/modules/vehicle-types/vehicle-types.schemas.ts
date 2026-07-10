const vehicleTypeSchema = {
  type: 'object',
  properties: {
    id: { type: 'integer' },
    name: { type: 'string' },
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

export const listVehicleTypesSchema = {
  response: { 200: { type: 'array', items: vehicleTypeSchema } },
} as const;

export const createVehicleTypeSchema = {
  body: {
    type: 'object',
    required: ['name'],
    additionalProperties: false,
    properties: {
      name: { type: 'string', minLength: 3, maxLength: 40 },
    },
  },
  response: { 201: vehicleTypeSchema },
} as const;

export const updateVehicleTypeSchema = {
  params: idParam,
  body: {
    type: 'object',
    additionalProperties: false,
    minProperties: 1,
    properties: {
      name: { type: 'string', minLength: 3, maxLength: 40 },
      active: { type: 'boolean' },
    },
  },
  response: { 200: vehicleTypeSchema },
} as const;

export const deleteVehicleTypeSchema = {
  params: idParam,
  response: { 204: { type: 'null' } },
} as const;
