/** Represents the enum public.driver_status */
type DriverStatus = 
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'suspended'
  | 'paused'
  | 'overdue'
  | 'penalized'
  | 'scheduled'
  | 'applicant';

export type { DriverStatus as default };