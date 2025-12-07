import { describe, it, expect } from 'vitest';
import * as path from 'path';
import {
  resolveSafePath,
} from '../src/utils/fs.js';

describe('File System Utilities', () => {
  describe('resolveSafePath', () => {
    const baseDir = '/app/data';
    
    it('should resolve valid relative paths', () => {
      const result = resolveSafePath(baseDir, 'subdir/file.txt');
      expect(result).toBe(path.resolve(baseDir, 'subdir/file.txt'));
    });
    
    it('should resolve paths with ./', () => {
      const result = resolveSafePath(baseDir, './file.txt');
      expect(result).toBe(path.resolve(baseDir, 'file.txt'));
    });
    
    it('should reject path traversal with ../', () => {
      expect(() => resolveSafePath(baseDir, '../etc/passwd')).toThrow('Path traversal detected');
    });
    
    it('should reject absolute paths outside base', () => {
      expect(() => resolveSafePath(baseDir, '/etc/passwd')).toThrow('Path traversal detected');
    });
    
    it('should reject complex traversal attempts', () => {
      expect(() => resolveSafePath(baseDir, 'subdir/../../etc/passwd')).toThrow('Path traversal detected');
    });
    
    it('should allow path that resolves to base directory itself', () => {
      const result = resolveSafePath(baseDir, '.');
      expect(result).toBe(path.resolve(baseDir));
    });
    
    it('should handle nested valid paths', () => {
      const result = resolveSafePath(baseDir, 'a/b/c/d/e/file.txt');
      expect(result).toBe(path.resolve(baseDir, 'a/b/c/d/e/file.txt'));
    });
  });
});

