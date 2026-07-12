module.exports = {
  content: ["./views/**/*.ejs", "./public/js/**/*.js"],
  prefix: "tw-",
  corePlugins: { preflight: false },
  theme: { extend: { colors: { accent: "#9CD9DE", ice: "#D8F4F2", sky: "#83BDD2", steel: "#5B93B0", ink: "#0A1B25" } } },
  plugins: [],
};
