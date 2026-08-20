/** Represents the enum public.notification_type */
type NotificationType = 
  | 'charge_issued'
  | 'charge_reminder'
  | 'debt_overdue'
  | 'penalty_applied'
  | 'driver_reactivated'
  | 'tariff_starting'
  | 'payment_received'
  | 'payment_approved'
  | 'payment_rejected'
  | 'application_approved'
  | 'application_rejected'
  | 'document_approved'
  | 'document_rejected'
  | 'vehicle_approved'
  | 'vehicle_rejected';

export type { NotificationType as default };