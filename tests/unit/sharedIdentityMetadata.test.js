import { describe, expect, test } from '@jest/globals';
import { sharedIdentityIndicator, sharedIdentityMetadata } from '../../lib/shared-identity-metadata.js';

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

  test('assigns stable accessible colors by sorted alias without exposing opaque IDs', () => {
    const aliases = {
      work: `hermes_camofox_${'b'.repeat(24)}`,
      home: `hermes_camofox_${'a'.repeat(24)}`,
    };
    expect(sharedIdentityIndicator(aliases, aliases.home)).toEqual({
      alias: 'home', userId: aliases.home, displayName: 'Home',
      accent: 'hsl(210 62% 38%)', background: 'hsl(210 72% 88%)', text: '#172033',
    });
    expect(sharedIdentityIndicator(aliases, aliases.work)).toEqual(expect.objectContaining({
      alias: 'work', background: 'hsl(148 72% 88%)',
    }));
    expect(sharedIdentityIndicator(aliases, `hermes_camofox_${'c'.repeat(24)}`)).toBeNull();
  });
});
