import { describe, it, expect, beforeEach } from 'vitest';
import {
  WorkspaceConfigService,
  InstallLogService,
} from '../src/config/workspace.js';

describe('Config Module', () => {
  describe('WorkspaceConfigService', () => {
    let service: WorkspaceConfigService;

    beforeEach(() => {
      service = new WorkspaceConfigService();
    });

    it('should return immutable snapshot', () => {
      const snapshot = service.getSnapshot();
      expect(Object.isFrozen(snapshot)).toBe(true);
    });

    it('should have default values', () => {
      const config = service.getSnapshot();
      expect(config.defaultFqbn).toBe('esp32:esp32:esp32');
      expect(config.defaultBaud).toBe(115200);
      expect(config.portNicknames).toEqual({});
    });

    it('should not allow modification of snapshot', () => {
      const snapshot = service.getSnapshot();
      expect(() => {
        (snapshot as { defaultBaud: number }).defaultBaud = 9600;
      }).toThrow();
    });

    it('should return undefined for unknown port nickname', () => {
      const nickname = service.getPortNickname('/dev/unknown');
      expect(nickname).toBeUndefined();
    });
  });

  describe('InstallLogService', () => {
    let configService: WorkspaceConfigService;
    let logService: InstallLogService;

    beforeEach(() => {
      configService = new WorkspaceConfigService();
      logService = new InstallLogService(configService);
    });

    it('should parse RegisteredInfo pattern', () => {
      const line = '::RegisteredInfo::["LacisID:12345678901234567890","RegisterStatus:Registered","cic:123456"]';
      const result = logService.parseRegisteredInfo(line);
      
      expect(result).not.toBeNull();
      expect(result?.lacisID).toBe('12345678901234567890');
      expect(result?.RegisterStatus).toBe('Registered');
      expect(result?.cic).toBe('123456');
    });

    it('should parse full RegisteredInfo with all fields', () => {
      const line = '::RegisteredInfo::["LacisID:12345","RegisterStatus:Issued","cic:111111","mainssid:ssid1","mainpass:pass1","altssid:ssid2","altpass:pass2","devssid:ssid3","devpass:pass3"]';
      const result = logService.parseRegisteredInfo(line);
      
      expect(result).not.toBeNull();
      expect(result?.mainssid).toBe('ssid1');
      expect(result?.mainpass).toBe('pass1');
      expect(result?.altssid).toBe('ssid2');
      expect(result?.devssid).toBe('ssid3');
    });

    it('should return null for non-matching lines', () => {
      const line = 'Some random log message';
      const result = logService.parseRegisteredInfo(line);
      expect(result).toBeNull();
    });

    it('should return null for empty RegisteredInfo', () => {
      const line = '::RegisteredInfo::[]';
      const result = logService.parseRegisteredInfo(line);
      expect(result).toBeNull();
    });

    it('should handle malformed pairs gracefully', () => {
      const line = '::RegisteredInfo::["LacisID:123","malformed","cic:456"]';
      const result = logService.parseRegisteredInfo(line);
      
      expect(result).not.toBeNull();
      expect(result?.lacisID).toBe('123');
      expect(result?.cic).toBe('456');
    });
  });
});

