const {z} = require("zod");

const createProductSchema = z.object({
  name: z.string().min(1),
  price: z.number().positive(),
  stock: z.number().int().nonnegative(),
});

const updateProductSchema = z.object({
    name: z.string().min(1).optional(),
    price: z.number().positive().optional(),
    stock: z.number().int().nonnegative().optional(),
});

module.exports = {
  createProductSchema,
  updateProductSchema
};