#!/usr/bin/env python3
"""
Tests for ragstore helpers.
"""

import hashlib
import os
from unittest import TestCase, main

from ragstore import chunk_text, validate_collection_name


class TestChunkText(TestCase):
    def test_basic_chunking(self):
        text = " ".join(f"word{i}" for i in range(20))
        chunks = chunk_text(text, chunk_size=10, overlap=2)
        self.assertEqual(len(chunks), 3)

    def test_empty_text(self):
        self.assertEqual(chunk_text("", chunk_size=10, overlap=2), [])

    def test_single_chunk(self):
        text = "hello world"
        chunks = chunk_text(text, chunk_size=100, overlap=10)
        self.assertEqual(len(chunks), 1)
        self.assertEqual(chunks[0], "hello world")

    def test_overlap_too_large_exits(self):
        with self.assertRaises(SystemExit):
            chunk_text("some text here", chunk_size=5, overlap=5)

    def test_overlap_larger_than_chunk_exits(self):
        with self.assertRaises(SystemExit):
            chunk_text("some text here", chunk_size=5, overlap=10)


class TestValidateCollectionName(TestCase):
    def test_valid_names(self):
        for name in ["books", "my-docs", "work_notes", "A123"]:
            self.assertEqual(validate_collection_name(name), name)

    def test_invalid_names_exit(self):
        for name in ["../etc", "my docs", "col;drop", "a/b"]:
            with self.assertRaises(SystemExit):
                validate_collection_name(name)


class TestChunkIdUniqueness(TestCase):
    """Ensure files with same basename but different paths produce different IDs."""

    def test_different_paths_produce_different_ids(self):
        path_a = os.path.realpath("/home/user/books/notes.txt")
        path_b = os.path.realpath("/home/user/work/notes.txt")
        id_a = hashlib.md5(f"{path_a}:0".encode()).hexdigest()
        id_b = hashlib.md5(f"{path_b}:0".encode()).hexdigest()
        self.assertNotEqual(id_a, id_b)

    def test_same_path_produces_same_id(self):
        path = os.path.realpath("/home/user/docs/readme.md")
        id1 = hashlib.md5(f"{path}:0".encode()).hexdigest()
        id2 = hashlib.md5(f"{path}:0".encode()).hexdigest()
        self.assertEqual(id1, id2)


if __name__ == "__main__":
    main()
