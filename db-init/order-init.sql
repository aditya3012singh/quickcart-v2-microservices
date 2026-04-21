CREATE TABLE IF NOT EXISTS orders (
  id SERIAL PRIMARY KEY,
  product_id INT,
  quantity INT,
  status TEXT
);
