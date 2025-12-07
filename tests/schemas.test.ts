import { describe, it, expect } from 'vitest';
import {
  compileSchema,
  uploadSchema,
  monitorStartSchema,
  monitorStopSchema,
  quickstartSchema,
  eraseFlashSchema,
} from '../src/mcp/schemas.js';

describe('MCP Schemas', () => {
  describe('compileSchema', () => {
    it('should validate valid compile params', () => {
      const result = compileSchema.safeParse({
        sketch_path: '/path/to/sketch',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.sketch_path).toBe('/path/to/sketch');
        expect(result.data.export_bin).toBe(true); // default
        expect(result.data.clean).toBe(false); // default
      }
    });

    it('should handle build_props as object', () => {
      const result = compileSchema.safeParse({
        sketch_path: '/path/to/sketch',
        build_props: { DEBUG: '1', BOARD_TYPE: 'ESP32' },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.build_props).toEqual(['DEBUG=1', 'BOARD_TYPE=ESP32']);
      }
    });

    it('should handle build_props as array', () => {
      const result = compileSchema.safeParse({
        sketch_path: '/path/to/sketch',
        build_props: ['DEBUG=1', 'BOARD_TYPE=ESP32'],
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.build_props).toEqual(['DEBUG=1', 'BOARD_TYPE=ESP32']);
      }
    });

    it('should reject missing sketch_path', () => {
      const result = compileSchema.safeParse({});
      expect(result.success).toBe(false);
    });
  });

  describe('uploadSchema', () => {
    it('should validate valid upload params', () => {
      const result = uploadSchema.safeParse({
        sketch_path: '/path/to/sketch',
        port: '/dev/cu.usbserial-0001',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.port).toBe('/dev/cu.usbserial-0001');
        expect(result.data.verify).toBe(false); // default
      }
    });

    it('should reject missing port', () => {
      const result = uploadSchema.safeParse({
        sketch_path: '/path/to/sketch',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('monitorStartSchema', () => {
    it('should validate with defaults', () => {
      const result = monitorStartSchema.safeParse({
        port: '/dev/cu.usbserial-0001',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.baud).toBe(115200);
        expect(result.data.auto_baud).toBe(false);
        expect(result.data.max_seconds).toBe(0);
        expect(result.data.detect_reboot).toBe(true);
      }
    });

    it('should accept custom baud rate', () => {
      const result = monitorStartSchema.safeParse({
        port: '/dev/cu.usbserial-0001',
        baud: 74880,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.baud).toBe(74880);
      }
    });
  });

  describe('monitorStopSchema', () => {
    it('should allow token only', () => {
      const result = monitorStopSchema.safeParse({
        token: 'abc-123',
      });
      expect(result.success).toBe(true);
    });

    it('should allow port only', () => {
      const result = monitorStopSchema.safeParse({
        port: '/dev/cu.usbserial-0001',
      });
      expect(result.success).toBe(true);
    });

    it('should allow empty object', () => {
      const result = monitorStopSchema.safeParse({});
      expect(result.success).toBe(true);
    });
  });

  describe('quickstartSchema', () => {
    it('should work with no params', () => {
      const result = quickstartSchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.monitor_seconds).toBe(10); // default
      }
    });

    it('should accept all params', () => {
      const result = quickstartSchema.safeParse({
        sketch_path: '/path/to/sketch',
        port: '/dev/cu.usbserial-0001',
        monitor_seconds: 30,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.sketch_path).toBe('/path/to/sketch');
        expect(result.data.port).toBe('/dev/cu.usbserial-0001');
        expect(result.data.monitor_seconds).toBe(30);
      }
    });
  });

  describe('eraseFlashSchema', () => {
    it('should require port', () => {
      const result = eraseFlashSchema.safeParse({});
      expect(result.success).toBe(false);
    });

    it('should validate with port', () => {
      const result = eraseFlashSchema.safeParse({
        port: '/dev/cu.usbserial-0001',
      });
      expect(result.success).toBe(true);
    });
  });
});

