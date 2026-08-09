/** Represents the enum public.driver_status */
type DriverStatus = 
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'suspended'
  | 'paused'
  | 'overdue'
  | 'penalized'
  | 'scheduled';

export type { DriverStatus as default };