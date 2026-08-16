/* ============================================================
   config/cityData.js  —  HostelNode City + Sub-area Config
   Used by: city routes, SEO pages, homepage chips
============================================================ */

const CITIES = [
  {
    name:     "Mumbai",
    slug:     "mumbai",
    state:    "Maharashtra",
    emoji:    "🏙️",
    popular:  true,
    lat:      19.0760,
    lng:      72.8777,
    meta: {
      title:       "Best PG & Hostel in Mumbai | HostelNode",
      description: "Find verified PG, hostel & flat sharing in Mumbai. 500+ listings near top colleges. No brokerage. Direct owner contact.",
      keywords:    "pg in mumbai, hostel in mumbai, pg near me mumbai, student pg mumbai, flat sharing mumbai"
    },
    areas: [
      { name: "Navi Mumbai",     slug: "navi-mumbai",    searchKey: "Navi Mumbai" },
      { name: "Nerul",           slug: "nerul",           searchKey: "Nerul" },
      { name: "Seawoods",        slug: "seawoods",        searchKey: "Seawoods" },
      { name: "Panvel",          slug: "panvel",          searchKey: "Panvel" },
      { name: "Belapur",         slug: "belapur",         searchKey: "Belapur" },
      { name: "Kharghar",        slug: "kharghar",        searchKey: "Kharghar" },
      { name: "Vashi",           slug: "vashi",           searchKey: "Vashi" },
      { name: "Airoli",          slug: "airoli",          searchKey: "Airoli" },
      { name: "Andheri",         slug: "andheri",         searchKey: "Andheri" },
      { name: "Powai",           slug: "powai",           searchKey: "Powai" },
      { name: "Thane",           slug: "thane",           searchKey: "Thane" },
      { name: "Borivali",        slug: "borivali",        searchKey: "Borivali" },
      { name: "Kurla",           slug: "kurla",           searchKey: "Kurla" },
      { name: "Dadar",           slug: "dadar",           searchKey: "Dadar" },
      { name: "Bandra",          slug: "bandra",          searchKey: "Bandra" },
      { name: "Mulund",          slug: "mulund",          searchKey: "Mulund" },
      { name: "Worli",           slug: "worli",           searchKey: "Worli" },
      { name: "Goregaon",        slug: "goregaon",        searchKey: "Goregaon" },
      { name: "Malad",           slug: "malad",           searchKey: "Malad" },
      { name: "Chembur",         slug: "chembur",         searchKey: "Chembur" },
    ]
  },
  {
    name:    "Pune",
    slug:    "pune",
    state:   "Maharashtra",
    emoji:   "🎓",
    popular: true,
    lat:     18.5204,
    lng:     73.8567,
    meta: {
      title:       "Best PG & Hostel in Pune | HostelNode",
      description: "Find verified PG, hostel & flat sharing in Pune near top colleges. 400+ listings. No brokerage.",
      keywords:    "pg in pune, hostel in pune, student pg pune, pg near pune university, flat sharing pune"
    },
    areas: [
      { name: "Koregaon Park",   slug: "koregaon-park",  searchKey: "Koregaon Park" },
      { name: "Kothrud",         slug: "kothrud",         searchKey: "Kothrud" },
      { name: "Hadapsar",        slug: "hadapsar",        searchKey: "Hadapsar" },
      { name: "Wakad",           slug: "wakad",           searchKey: "Wakad" },
      { name: "Hinjewadi",       slug: "hinjewadi",       searchKey: "Hinjewadi" },
      { name: "Viman Nagar",     slug: "viman-nagar",     searchKey: "Viman Nagar" },
      { name: "Baner",           slug: "baner",           searchKey: "Baner" },
      { name: "Shivajinagar",    slug: "shivajinagar",    searchKey: "Shivajinagar" },
      { name: "Deccan",          slug: "deccan",          searchKey: "Deccan" },
      { name: "Pimpri",          slug: "pimpri",          searchKey: "Pimpri" },
      { name: "Chinchwad",       slug: "chinchwad",       searchKey: "Chinchwad" },
      { name: "Bibwewadi",       slug: "bibwewadi",       searchKey: "Bibwewadi" },
      { name: "Camp",            slug: "camp",            searchKey: "Camp Pune" },
      { name: "Kalyani Nagar",   slug: "kalyani-nagar",  searchKey: "Kalyani Nagar" },
      { name: "Mundhwa",         slug: "mundhwa",         searchKey: "Mundhwa" },
    ]
  },
  {
    name:    "Delhi",
    slug:    "delhi",
    state:   "Delhi",
    emoji:   "🏛️",
    popular: true,
    lat:     28.6139,
    lng:     77.2090,
    meta: {
      title:       "Best PG & Hostel in Delhi | HostelNode",
      description: "Find verified PG, hostel & flat sharing in Delhi near DU, JNU & top colleges. No brokerage.",
      keywords:    "pg in delhi, hostel in delhi, pg near delhi university, student pg delhi, flat sharing delhi"
    },
    areas: [
      { name: "Lajpat Nagar",    slug: "lajpat-nagar",   searchKey: "Lajpat Nagar" },
      { name: "Dwarka",          slug: "dwarka",          searchKey: "Dwarka" },
      { name: "Noida",           slug: "noida",           searchKey: "Noida" },
      { name: "Gurgaon",         slug: "gurgaon",         searchKey: "Gurgaon" },
      { name: "Rohini",          slug: "rohini",          searchKey: "Rohini" },
      { name: "Karol Bagh",      slug: "karol-bagh",      searchKey: "Karol Bagh" },
      { name: "Saket",           slug: "saket",           searchKey: "Saket" },
      { name: "Vasant Kunj",     slug: "vasant-kunj",     searchKey: "Vasant Kunj" },
      { name: "Janakpuri",       slug: "janakpuri",       searchKey: "Janakpuri" },
      { name: "Pitampura",       slug: "pitampura",       searchKey: "Pitampura" },
      { name: "Mukherjee Nagar", slug: "mukherjee-nagar", searchKey: "Mukherjee Nagar" },
      { name: "Hudson Lane",     slug: "hudson-lane",     searchKey: "Hudson Lane" },
      { name: "GTB Nagar",       slug: "gtb-nagar",       searchKey: "GTB Nagar" },
      { name: "Shahdara",        slug: "shahdara",        searchKey: "Shahdara" },
      { name: "Rajouri Garden",  slug: "rajouri-garden",  searchKey: "Rajouri Garden" },
    ]
  },
  {
    name:    "Hyderabad",
    slug:    "hyderabad",
    state:   "Telangana",
    emoji:   "🔬",
    popular: true,
    lat:     17.3850,
    lng:     78.4867,
    meta: {
      title:       "Best PG & Hostel in Hyderabad | HostelNode",
      description: "Find verified PG, hostel & flat sharing in Hyderabad near JNTU, Osmania & top colleges.",
      keywords:    "pg in hyderabad, hostel in hyderabad, student pg hyderabad, pg near jntu, flat sharing hyderabad"
    },
    areas: [
      { name: "Ameerpet",        slug: "ameerpet",        searchKey: "Ameerpet" },
      { name: "Kukatpally",      slug: "kukatpally",      searchKey: "Kukatpally" },
      { name: "Gachibowli",      slug: "gachibowli",      searchKey: "Gachibowli" },
      { name: "Madhapur",        slug: "madhapur",        searchKey: "Madhapur" },
      { name: "Kondapur",        slug: "kondapur",        searchKey: "Kondapur" },
      { name: "Begumpet",        slug: "begumpet",        searchKey: "Begumpet" },
      { name: "Himayatnagar",    slug: "himayatnagar",    searchKey: "Himayatnagar" },
      { name: "SR Nagar",        slug: "sr-nagar",        searchKey: "SR Nagar" },
      { name: "LB Nagar",        slug: "lb-nagar",        searchKey: "LB Nagar" },
      { name: "Dilsukhnagar",    slug: "dilsukhnagar",    searchKey: "Dilsukhnagar" },
      { name: "Uppal",           slug: "uppal",           searchKey: "Uppal" },
      { name: "Secunderabad",    slug: "secunderabad",    searchKey: "Secunderabad" },
      { name: "Miyapur",         slug: "miyapur",         searchKey: "Miyapur" },
      { name: "Manikonda",       slug: "manikonda",       searchKey: "Manikonda" },
    ]
  },
  {
    name:    "Bangalore",
    slug:    "bangalore",
    state:   "Karnataka",
    emoji:   "💻",
    popular: true,
    lat:     12.9716,
    lng:     77.5946,
    meta: {
      title:       "Best PG & Hostel in Bangalore | HostelNode",
      description: "Find verified PG, hostel & flat sharing in Bangalore near Christ, BMS & top colleges.",
      keywords:    "pg in bangalore, hostel in bangalore, student pg bangalore, pg near christ university, flat sharing bangalore"
    },
    areas: [
      { name: "Koramangala",     slug: "koramangala",     searchKey: "Koramangala" },
      { name: "Electronic City", slug: "electronic-city", searchKey: "Electronic City" },
      { name: "HSR Layout",      slug: "hsr-layout",      searchKey: "HSR Layout" },
      { name: "Whitefield",      slug: "whitefield",      searchKey: "Whitefield" },
      { name: "BTM Layout",      slug: "btm-layout",      searchKey: "BTM Layout" },
      { name: "Marathahalli",    slug: "marathahalli",    searchKey: "Marathahalli" },
      { name: "Indiranagar",     slug: "indiranagar",     searchKey: "Indiranagar" },
      { name: "JP Nagar",        slug: "jp-nagar",        searchKey: "JP Nagar" },
      { name: "Hebbal",          slug: "hebbal",          searchKey: "Hebbal" },
      { name: "Yelahanka",       slug: "yelahanka",       searchKey: "Yelahanka" },
      { name: "Rajajinagar",     slug: "rajajinagar",     searchKey: "Rajajinagar" },
      { name: "Jayanagar",       slug: "jayanagar",       searchKey: "Jayanagar" },
      { name: "Banashankari",    slug: "banashankari",    searchKey: "Banashankari" },
      { name: "Malleswaram",     slug: "malleswaram",     searchKey: "Malleswaram" },
    ]
  },
  {
    name:    "Indore",
    slug:    "indore",
    state:   "Madhya Pradesh",
    emoji:   "🌆",
    popular: true,
    lat:     22.7196,
    lng:     75.8577,
    meta: {
      title:       "Best PG & Hostel in Indore | HostelNode",
      description: "Find verified PG, hostel & flat sharing in Indore near IIM, DAVV & top colleges. No brokerage.",
      keywords:    "pg in indore, hostel in indore, student pg indore, pg near iim indore, flat sharing indore"
    },
    areas: [
      { name: "Vijay Nagar",     slug: "vijay-nagar",     searchKey: "Vijay Nagar" },
      { name: "Palasia",         slug: "palasia",          searchKey: "Palasia" },
      { name: "Sapna Sangeeta",  slug: "sapna-sangeeta",  searchKey: "Sapna Sangeeta" },
      { name: "MR-9",            slug: "mr-9",             searchKey: "MR-9" },
      { name: "Bhawarkuan",      slug: "bhawarkuan",       searchKey: "Bhawarkuan" },
      { name: "Rajwada",         slug: "rajwada",          searchKey: "Rajwada" },
      { name: "Scheme 54",       slug: "scheme-54",        searchKey: "Scheme 54" },
      { name: "LIG Colony",      slug: "lig-colony",       searchKey: "LIG Colony" },
      { name: "Nipania",         slug: "nipania",          searchKey: "Nipania" },
      { name: "AB Road",         slug: "ab-road",          searchKey: "AB Road Indore" },
    ]
  },
  {
    name:    "Kota",
    slug:    "kota",
    state:   "Rajasthan",
    emoji:   "📚",
    popular: true,
    lat:     25.2138,
    lng:     75.8648,
    meta: {
      title:       "Best PG & Hostel in Kota | HostelNode",
      description: "Find verified PG & hostel in Kota for JEE & NEET students. Safe, affordable, near coaching institutes.",
      keywords:    "pg in kota, hostel in kota, student pg kota, jee neet hostel kota, coaching hostel kota"
    },
    areas: [
      { name: "Talwandi",        slug: "talwandi",         searchKey: "Talwandi" },
      { name: "Mahaveer Nagar",  slug: "mahaveer-nagar",  searchKey: "Mahaveer Nagar" },
      { name: "Vigyan Nagar",    slug: "vigyan-nagar",    searchKey: "Vigyan Nagar" },
      { name: "Kunhari",         slug: "kunhari",          searchKey: "Kunhari" },
      { name: "Rajiv Gandhi Nagar", slug: "rgn",          searchKey: "Rajiv Gandhi Nagar Kota" },
      { name: "Gumanpura",       slug: "gumanpura",        searchKey: "Gumanpura" },
      { name: "Jawahar Nagar",   slug: "jawahar-nagar-kota", searchKey: "Jawahar Nagar Kota" },
      { name: "Sangod Road",     slug: "sangod-road",     searchKey: "Sangod Road" },
    ]
  },
  {
    name:    "Jaipur",
    slug:    "jaipur",
    state:   "Rajasthan",
    emoji:   "🏰",
    popular: true,
    lat:     26.9124,
    lng:     75.7873,
    meta: {
      title:       "Best PG & Hostel in Jaipur | HostelNode",
      description: "Find verified PG, hostel & flat sharing in Jaipur near Rajasthan University & top colleges.",
      keywords:    "pg in jaipur, hostel in jaipur, student pg jaipur, pg near rajasthan university, flat sharing jaipur"
    },
    areas: [
      { name: "Malviya Nagar",   slug: "malviya-nagar",   searchKey: "Malviya Nagar" },
      { name: "Vaishali Nagar",  slug: "vaishali-nagar",  searchKey: "Vaishali Nagar" },
      { name: "Tonk Road",       slug: "tonk-road",       searchKey: "Tonk Road" },
      { name: "Mansarovar",      slug: "mansarovar",      searchKey: "Mansarovar" },
      { name: "Civil Lines",     slug: "civil-lines",     searchKey: "Civil Lines Jaipur" },
      { name: "Bapu Nagar",      slug: "bapu-nagar",      searchKey: "Bapu Nagar" },
      { name: "Raja Park",       slug: "raja-park",       searchKey: "Raja Park" },
      { name: "Jagatpura",       slug: "jagatpura",       searchKey: "Jagatpura" },
      { name: "Sitapura",        slug: "sitapura",        searchKey: "Sitapura" },
      { name: "Pratap Nagar",    slug: "pratap-nagar-jaipur", searchKey: "Pratap Nagar Jaipur" },
    ]
  },
  {
    name:    "Chennai",
    slug:    "chennai",
    state:   "Tamil Nadu",
    emoji:   "🌊",
    popular: false,
    lat:     13.0827,
    lng:     80.2707,
    meta: {
      title:       "Best PG & Hostel in Chennai | HostelNode",
      description: "Find verified PG, hostel & flat sharing in Chennai near Anna University & top colleges.",
      keywords:    "pg in chennai, hostel in chennai, student pg chennai, pg near anna university"
    },
    areas: [
      { name: "Adyar",           slug: "adyar",           searchKey: "Adyar" },
      { name: "Velachery",       slug: "velachery",       searchKey: "Velachery" },
      { name: "OMR",             slug: "omr",             searchKey: "OMR Chennai" },
      { name: "T Nagar",         slug: "t-nagar",         searchKey: "T Nagar" },
      { name: "Anna Nagar",      slug: "anna-nagar",      searchKey: "Anna Nagar" },
      { name: "Tambaram",        slug: "tambaram",        searchKey: "Tambaram" },
      { name: "Guindy",          slug: "guindy",          searchKey: "Guindy" },
      { name: "Perambur",        slug: "perambur",        searchKey: "Perambur" },
    ]
  },
  {
    name:    "Kolkata",
    slug:    "kolkata",
    state:   "West Bengal",
    emoji:   "🎭",
    popular: false,
    lat:     22.5726,
    lng:     88.3639,
    meta: {
      title:       "Best PG & Hostel in Kolkata | HostelNode",
      description: "Find verified PG, hostel & flat sharing in Kolkata near Jadavpur, Presidency & top colleges.",
      keywords:    "pg in kolkata, hostel in kolkata, student pg kolkata, pg near jadavpur university"
    },
    areas: [
      { name: "Salt Lake",       slug: "salt-lake",       searchKey: "Salt Lake" },
      { name: "New Town",        slug: "new-town",        searchKey: "New Town Kolkata" },
      { name: "Jadavpur",        slug: "jadavpur",        searchKey: "Jadavpur" },
      { name: "Garia",           slug: "garia",           searchKey: "Garia" },
      { name: "Tollygunge",      slug: "tollygunge",      searchKey: "Tollygunge" },
      { name: "Howrah",          slug: "howrah",          searchKey: "Howrah" },
      { name: "Dum Dum",         slug: "dum-dum",         searchKey: "Dum Dum" },
    ]
  },
  {
    name:    "Nagpur",
    slug:    "nagpur",
    state:   "Maharashtra",
    emoji:   "🟠",
    popular: false,
    lat:     21.1458,
    lng:     79.0882,
    meta: {
      title:       "Best PG & Hostel in Nagpur | HostelNode",
      description: "Find verified PG, hostel & flat sharing in Nagpur near VNIT, RCOEM & top colleges.",
      keywords:    "pg in nagpur, hostel in nagpur, student pg nagpur, pg near vnit nagpur"
    },
    areas: [
      { name: "Dharampeth",      slug: "dharampeth",      searchKey: "Dharampeth" },
      { name: "Sitabuldi",       slug: "sitabuldi",       searchKey: "Sitabuldi" },
      { name: "Manish Nagar",    slug: "manish-nagar",    searchKey: "Manish Nagar Nagpur" },
      { name: "Laxmi Nagar",     slug: "laxmi-nagar-ngp", searchKey: "Laxmi Nagar Nagpur" },
      { name: "Trimurti Nagar",  slug: "trimurti-nagar",  searchKey: "Trimurti Nagar" },
    ]
  },
  {
    name:    "Bhopal",
    slug:    "bhopal",
    state:   "Madhya Pradesh",
    emoji:   "🏞️",
    popular: false,
    lat:     23.2599,
    lng:     77.4126,
    meta: {
      title:       "Best PG & Hostel in Bhopal | HostelNode",
      description: "Find verified PG, hostel & flat sharing in Bhopal near MANIT, Barkatullah University & colleges.",
      keywords:    "pg in bhopal, hostel in bhopal, student pg bhopal, pg near manit bhopal"
    },
    areas: [
      { name: "MP Nagar",        slug: "mp-nagar",        searchKey: "MP Nagar" },
      { name: "Arera Colony",    slug: "arera-colony",    searchKey: "Arera Colony" },
      { name: "Kolar Road",      slug: "kolar-road",      searchKey: "Kolar Road" },
      { name: "Hoshangabad Road",slug: "hoshangabad-road",searchKey: "Hoshangabad Road" },
      { name: "TT Nagar",        slug: "tt-nagar",        searchKey: "TT Nagar" },
    ]
  },
];

// Helper: get city by slug
function getCityBySlug(slug) {
  return CITIES.find(c => c.slug === slug) || null;
}

// Helper: get area within city
function getAreaBySlug(citySlug, areaSlug) {
  const city = getCityBySlug(citySlug);
  if (!city) return null;
  return city.areas.find(a => a.slug === areaSlug) || null;
}

// Popular cities for homepage chips
function getPopularCities() {
  return CITIES.filter(c => c.popular);
}

// All cities for sitemap
function getAllCities() {
  return CITIES;
}

module.exports = { CITIES, getCityBySlug, getAreaBySlug, getPopularCities, getAllCities };