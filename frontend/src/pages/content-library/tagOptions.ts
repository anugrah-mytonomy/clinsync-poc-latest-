/**
 * Tag choices for the Tag Documents step. The backend's specialty / document_type masters are deferred (no API
 * yet), so the lists live here until they are served.
 */
export const SPECIALTY_OPTIONS = [
  'Cardiology',
  'Dermatology',
  'Endocrinology',
  'Gastroenterology',
  'General Surgery',
  'Neurology',
  'Obstetrics & Gynecology',
  'Oncology',
  'Orthopedics',
  'Pediatrics',
  'Pulmonology',
  'Urology',
  'Wound Care',
] as const;

export const DOCUMENT_TYPE_OPTIONS = [
  'Patient Education',
  'Procedure Guide',
  'Care Protocol',
  'Pre-Op Instructions',
  'Post-Op Instructions',
  'Discharge Instructions',
  'Medication Guide',
] as const;
