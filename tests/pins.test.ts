import { describe, it, expect } from 'vitest';
import {
  DEVKITC_PIN_SPEC,
  PIN_ALIAS,
  resolvePinNumber,
  getPinSpec,
  validatePinForOutput,
  validatePinForInput,
  formatPinSpec,
} from '../src/utils/pins.js';

describe('Pin Utilities', () => {
  describe('DEVKITC_PIN_SPEC', () => {
    it('should have correct number of pins', () => {
      expect(DEVKITC_PIN_SPEC.length).toBeGreaterThan(20);
    });

    it('should have GPIO0 as boot strapping pin', () => {
      const gpio0 = DEVKITC_PIN_SPEC.find(p => p.number === 0);
      expect(gpio0).toBeDefined();
      expect(gpio0?.strapping).toBe(true);
    });

    it('should mark GPIO6-11 as unavailable (SPI flash)', () => {
      for (let i = 6; i <= 11; i++) {
        const pin = DEVKITC_PIN_SPEC.find(p => p.number === i);
        expect(pin?.available).toBe(false);
      }
    });

    it('should mark GPIO34-39 as input-only', () => {
      for (const num of [34, 35, 36, 39]) {
        const pin = DEVKITC_PIN_SPEC.find(p => p.number === num);
        expect(pin?.inputOnly).toBe(true);
        expect(pin?.digitalOut).toBe(false);
      }
    });
  });

  describe('PIN_ALIAS', () => {
    it('should resolve LED_BUILTIN to GPIO2', () => {
      expect(PIN_ALIAS['LED_BUILTIN']).toBe(2);
    });

    it('should resolve SDA/SCL to correct pins', () => {
      expect(PIN_ALIAS['SDA']).toBe(21);
      expect(PIN_ALIAS['SCL']).toBe(22);
    });

    it('should resolve GPIO aliases', () => {
      expect(PIN_ALIAS['GPIO0']).toBe(0);
      expect(PIN_ALIAS['GPIO2']).toBe(2);
      expect(PIN_ALIAS['IO18']).toBe(18);
    });
  });

  describe('resolvePinNumber', () => {
    it('should resolve numeric strings', () => {
      expect(resolvePinNumber('2')).toBe(2);
      expect(resolvePinNumber('18')).toBe(18);
    });

    it('should resolve aliases', () => {
      expect(resolvePinNumber('LED_BUILTIN')).toBe(2);
      expect(resolvePinNumber('SDA')).toBe(21);
      expect(resolvePinNumber('GPIO13')).toBe(13);
    });

    it('should be case-insensitive', () => {
      expect(resolvePinNumber('led_builtin')).toBe(2);
      expect(resolvePinNumber('sda')).toBe(21);
    });

    it('should return null for unknown identifiers', () => {
      expect(resolvePinNumber('UNKNOWN_PIN')).toBeNull();
      expect(resolvePinNumber('GPIO99')).toBeNull();
    });
  });

  describe('getPinSpec', () => {
    it('should return spec for valid pin', () => {
      const spec = getPinSpec(2);
      expect(spec).toBeDefined();
      expect(spec?.name).toBe('IO2');
    });

    it('should return undefined for invalid pin', () => {
      expect(getPinSpec(99)).toBeUndefined();
    });
  });

  describe('validatePinForOutput', () => {
    it('should allow GPIO2 for output', () => {
      const warnings = validatePinForOutput(2);
      // GPIO2 is strapping pin, so there should be a warning
      expect(warnings.some(w => w.type === 'strapping')).toBe(true);
      expect(warnings.some(w => w.severity === 'error')).toBe(false);
    });

    it('should error on GPIO6 (SPI flash)', () => {
      const warnings = validatePinForOutput(6);
      expect(warnings.some(w => w.type === 'reserved')).toBe(true);
      expect(warnings.some(w => w.severity === 'error')).toBe(true);
    });

    it('should error on GPIO34 (input-only)', () => {
      const warnings = validatePinForOutput(34);
      expect(warnings.some(w => w.type === 'input_only')).toBe(true);
      expect(warnings.some(w => w.severity === 'error')).toBe(true);
    });

    it('should allow GPIO18 for output with no errors', () => {
      const warnings = validatePinForOutput(18);
      expect(warnings.every(w => w.severity !== 'error')).toBe(true);
    });
  });

  describe('validatePinForInput', () => {
    it('should allow GPIO34 for input', () => {
      const warnings = validatePinForInput(34);
      expect(warnings.every(w => w.severity !== 'error')).toBe(true);
    });

    it('should error on GPIO6 (SPI flash)', () => {
      const warnings = validatePinForInput(6);
      expect(warnings.some(w => w.severity === 'error')).toBe(true);
    });
  });

  describe('formatPinSpec', () => {
    it('should return formatted string', () => {
      const output = formatPinSpec();
      expect(output).toContain('ESP32-DevKitC Pin Specification');
      expect(output).toContain('IO0');
      expect(output).toContain('IO2');
    });
  });
});

