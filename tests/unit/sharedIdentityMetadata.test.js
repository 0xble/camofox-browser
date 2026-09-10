import { describe, expect, test } from '@jest/globals';
import { sharedIdentityMetadata } from '../../lib/shared-identity-metadata.js';

describe('sharedIdentityMetadata', () => {
  test('returns only safe dynamic metadata in stable alias order', () => {
    expect(sharedIdentityMetadata({
      work_space: `hermes_camofox_${'b'.repeat(24)}`,
      home: `hermes_camofox_${'a'.repeat(24)}`,
      duplicate: `hermes_camofox_${'a'.repeat(24)}`,
      'Not Safe': `hermes_camofox_${'c'.repeat(24)}`,
    })).toEqual([
      { alias: 'home', userId: `hermes_camofox_${'a'.repeat(24)}`, displayName: 'Home' },
      { alias: 'work_space', userId: `hermes_camofox_${'b'.repeat(24)}`, displayName: 'Work Space' },
    ]);
  });
});
