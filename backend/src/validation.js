import { KSA_BBOX } from './config.js';

export class ValidationError extends Error {
  constructor(details) {
    super('validation_failed');
    this.status = 400;
    this.details = details;
  }
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

export function validateReport(body = {}) {
  const errors = {};
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const description = typeof body.description === 'string' ? body.description.trim() : null;
  const intensity = Number(body.intensity);
  const latitude = Number(body.latitude);
  const longitude = Number(body.longitude);

  if (title.length < 3 || title.length > 200) errors.title = 'title must be 3–200 characters';
  if (description && description.length > 2000) errors.description = 'description must be ≤ 2000 characters';
  if (!Number.isInteger(intensity) || intensity < 1 || intensity > 5) errors.intensity = 'intensity must be an integer 1–5';
  if (!isNum(latitude) || !isNum(longitude)) {
    errors.location = 'latitude and longitude are required numbers';
  } else if (
    latitude < KSA_BBOX.minLat || latitude > KSA_BBOX.maxLat ||
    longitude < KSA_BBOX.minLng || longitude > KSA_BBOX.maxLng
  ) {
    errors.location = 'location must be inside Saudi Arabia';
  }

  if (Object.keys(errors).length) throw new ValidationError(errors);
  return { title, description: description || null, intensity, latitude, longitude };
}

/** Parses "minLng,minLat,maxLng,maxLat". */
export function parseBbox(raw) {
  const parts = String(raw || '').split(',').map(Number);
  if (parts.length !== 4 || !parts.every(isNum)) {
    throw new ValidationError({ bbox: 'bbox must be minLng,minLat,maxLng,maxLat' });
  }
  const [minLng, minLat, maxLng, maxLat] = parts;
  if (minLng >= maxLng || minLat >= maxLat) throw new ValidationError({ bbox: 'bbox min must be < max' });
  return { minLng, minLat, maxLng, maxLat };
}

export const STATUSES = ['pending', 'verified', 'rejected'];
