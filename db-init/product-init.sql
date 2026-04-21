CREATE TABLE IF NOT EXISTS products (
  id INT PRIMARY KEY,
  stock INT,
  reserved_stock INT DEFAULT 0
);

-- Seed data
INSERT INTO products (id, stock, reserved_stock)
VALUES (1, 10, 0)
ON CONFLICT (id) DO NOTHING;
