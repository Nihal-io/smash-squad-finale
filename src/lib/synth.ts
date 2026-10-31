// Shared banks for synthetic enrichment. Names and colleges are invented; no real people or institutions.

export type Gender = "female" | "male" | "non-binary";
export type Tier = 1 | 2 | 3;

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const FIRST_F = ["Ananya", "Priya", "Meera", "Kavya", "Sneha", "Riya", "Ishita", "Divya", "Nandini", "Aisha", "Pooja", "Shreya", "Tanvi", "Neha", "Lakshmi", "Sara", "Zoya", "Elena", "Mariam", "Chloe", "Hana", "Lucia", "Ines", "Fatima", "Amara", "Yuki", "Sofia", "Leila", "Nora", "Maya"];
export const FIRST_M = ["Arjun", "Rohan", "Aditya", "Karthik", "Vikram", "Rahul", "Siddharth", "Nikhil", "Varun", "Aman", "Dev", "Harsh", "Kunal", "Manish", "Pranav", "Omar", "Daniel", "Mateo", "Tomas", "Felix", "Samuel", "Yusuf", "Leon", "Ivan", "Kenji", "Marcus", "Andre", "Tariq", "Elias", "Ravi"];
export const FIRST_NB = ["Sam", "Alex", "Robin", "Kiran", "Noor", "Avi", "Jay", "Ira", "Ren", "Sky"];
export const LAST = ["Sharma", "Iyer", "Patel", "Nair", "Reddy", "Menon", "Gupta", "Bose", "Rao", "Kulkarni", "Desai", "Chawla", "Kapoor", "Mehta", "Verma", "Joshi", "Pillai", "Bhat", "Saxena", "Mukherjee", "Okafor", "Novak", "Haddad", "Lindqvist", "Moreau", "Tanaka", "Silva", "Kowalski", "Ahmed", "Nguyen", "Garcia", "Petrov", "Osei", "Fischer"];

export const TIER1 = ["Northfield Institute of Technology", "Meridian Institute of Technology", "Carrow National Institute", "Aldergate Institute of Science"];
export const TIER2 = ["Westbrook University", "Lakeside State University", "Harrowgate College of Engineering", "Sunfield Technical University", "St. Ada's College for Women"];
export const TIER3 = ["Riverbend Polytechnic", "Greenhill Institute", "Eastvale Engineering College", "Pinecrest Community College", "Oakridge Institute of Technology", "Bluefield College"];
export const WOMENS_COLLEGE = "St. Ada's College for Women";
export const ALL_COLLEGES = [...TIER1, ...TIER2, ...TIER3];

export function pronouns(g: Gender) {
  return g === "female" ? { s: "she", o: "her", p: "her" } : g === "male" ? { s: "he", o: "him", p: "his" } : { s: "they", o: "them", p: "their" };
}
